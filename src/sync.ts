import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian'
import { Api, ApiError } from './api'
import { BoardCtx, LABEL_COLORS, Missing, Yaml, cardOrder, checklistNotes, holdPinned, labelTag, listRequestName, pickLabelColor, linkTarget, noteFileName, noteToPatch, parseCardNote, parseIndex, parseNote, planIndexMoves, renderBoardNote, renderCard, renderCardNote, renderGuideNote, renderIndex, renderArchiveNote, renderListNote, safeName, splitPatch, unlink, wikiLink } from './format'
import { confirmArchive } from './confirm'
import { ColorGroup, allColorGroups, mergeColorGroups, sameGroups, withArchiveFilter } from './graph'
import type { BHCard, BHEvent, BHLabel, BHList, BHNote, BHSnapshot, CardPatch } from './types'

// Obsidian's core graph plugin isn't in the public API; only these parts are used, and each is checked first.
interface GraphPluginLike { options: { colorGroups?: unknown; search?: unknown }; saveOptions(): void }
interface GraphViewLike { dataEngine?: { setOptions?(o: { colorGroups?: ColorGroup[]; search?: string }): void } }

function graphPlugin(app: App): GraphPluginLike | null {
  const ip = (app as unknown as { internalPlugins?: { getPluginById?(id: string): { instance?: unknown } | null } }).internalPlugins
  const inst = ip?.getPluginById?.('graph')?.instance as Partial<GraphPluginLike> | undefined
  return inst && typeof inst.options === 'object' && inst.options && typeof inst.saveOptions === 'function' ? (inst as GraphPluginLike) : null
}

export interface Settings {
  server: string
  key: string
  vault: string
  userName: string
  boards: string[] // board ids to sync
  root: string // vault folder for everything
  folders: Record<string, string> // board id → its folder name (kept when the board is renamed)
  clientId: string
  kanban: boolean // also write <board>/_Kanban.md (Kanban plugin format; it links to every card)
  checklists: boolean // write <board>/Checklists/<card>/… : one note per checklist and item, for the graph
  graphColors: boolean // keep a graph color group per label, in the label's BoardHydra color
  hideArchived: boolean // keep `-path:_archive` in the graph's filter, so archived cards don't show
  guide: boolean // write <board>/_AI guide.md: the server's guide that explains the board to an AI working in the vault
  createFromNotes: boolean // a new note in Lists/, or a card naming a list or bh/ tag the board lacks, creates that list or label
}

const yaml: Yaml = { parse: parseYaml, stringify: stringifyYaml }
const PUSH_DELAY = 2000
const ARCHIVE = '_archive'
const CONFLICTS = '_conflicts'
const LISTS = 'Lists'
const KANBAN = '_Kanban'
const GUIDE = '_AI guide'
const GUIDE_EVERY = 6 * 60 * 60 * 1000 // refresh the guide at most this often (one request each)
const NOTES = 'Notes'
const CHECKLISTS = 'Checklists'
const ARCHIVE_NOTE = 'Archived cards'

export function genId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

interface BoardState {
  id: string
  snap: BHSnapshot
  cards: Map<string, BHCard>
  notes: Map<string, BHNote>
  folder: string // full vault path of the board's folder
  abort?: AbortController
  poll?: number
  live: boolean
}

export type Status = { text: string; error?: boolean }

/** What came of a card change: the card as the server now has it, the fields it refused, and why. */
interface Sent { card: BHCard; refused: string[]; reasons: string[] }

const TEXT_FIELDS = ['name', 'desc', 'checklists', 'links'] // refused edits to these are kept in _conflicts/

export class SyncEngine {
  private boards = new Map<string, BoardState>()
  private pathById = new Map<string, string>()
  private guideAt = new Map<string, number>() // board id → when its AI guide note was last fetched
  private selfWrites = new Map<string, string>() // path → text we just wrote (its modify event is ours)
  private selfMoves = new Set<string>() // paths we just renamed to
  private timers = new Map<string, number>()
  private pending = new Set<string>() // card ids with local edits waiting to go up
  private archiving = new Set<string>() // card ids whose note was deleted or archived here, until that's settled
  private creating = new Set<string>() // paths of new notes being created on the server
  private indexTimers = new Map<string, number>()
  private notePaths = new Map<string, string>() // BoardHydra note id → vault path
  private pendingNotes = new Set<string>() // note ids with local edits waiting to go up
  private selfDeletes = new Set<string>() // paths we just removed
  private queues = new Map<string, Promise<void>>() // board id → its events, applied one at a time
  private making = new Map<string, Promise<unknown>>() // "<board>:list|label:<name>" → its create, so one request makes it
  private refused = new Set<string>() // the same keys, after the server said no (told once, not retried this session)
  private graphTimer = 0
  private me: { id: string; name: string } | null = null
  private stopped = false
  paused = ''

  constructor(private app: App, private api: Api, private s: () => Settings, private onStatus: (st: Status) => void) {}

  private root() { return normalizePath(this.s().root || 'BoardHydra') }

  // ---------- start / stop ----------

  async start() {
    this.stopped = false
    this.paused = ''
    if (!this.s().key) return this.onStatus({ text: 'BoardHydra: not connected' })
    if (!this.s().boards.length) return this.onStatus({ text: 'BoardHydra: no boards chosen' })
    this.onStatus({ text: 'BoardHydra: syncing…' })
    if (!this.me) {
      try { const m = await this.api.me(); this.me = { id: m.id, name: m.name } } catch (e) { if (this.handleFatal(e)) return }
    }
    for (const id of this.s().boards) {
      try {
        await this.syncBoard(id)
        this.openStream(id)
      } catch (e) {
        if (this.handleFatal(e)) return
        new Notice(`BoardHydra: couldn’t sync a board — ${(e as Error).message}`)
      }
    }
    this.refreshStatus()
  }

  /** Runs board work in order: two events for one card must not both pick a file for it. */
  private enqueue(boardId: string, job: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(boardId) ?? Promise.resolve()).then(job, job)
    const settled = next.catch(() => {})
    this.queues.set(boardId, settled)
    void settled.then(() => { if (this.queues.get(boardId) === settled) this.queues.delete(boardId) })
    return next
  }

  // ---------- graph colors ----------

  scheduleGraph() {
    window.clearTimeout(this.graphTimer)
    this.graphTimer = window.setTimeout(() => { this.applyGraphColors().catch(() => {}) }, 500)
  }

  /**
   * One graph color group per label (tag:#bh/<label>), in the label's color. Your own groups are kept, ahead of ours.
   * Also keeps archived cards out of the graph (a `-path:_archive` term in its filter) while hideArchived is on.
   */
  async applyGraphColors() {
    const labels = this.s().graphColors ? [...this.boards.values()].flatMap((st) => [...st.snap.labels].sort((a, b) => a.pos - b.pos)) : []
    const keepGroups = this.s().graphColors && !this.boards.size // not synced yet: don't clear groups we wrote last time
    const ours = this.s().graphColors ? allColorGroups(labels) : []
    const hide = this.s().hideArchived !== false
    const graph = graphPlugin(this.app)
    if (graph) {
      const groups = keepGroups ? graph.options.colorGroups : mergeColorGroups(graph.options.colorGroups, ours)
      const search = withArchiveFilter(graph.options.search, hide)
      const groupsChanged = !keepGroups && !sameGroups(graph.options.colorGroups, groups as ColorGroup[])
      const searchChanged = search !== (typeof graph.options.search === 'string' ? graph.options.search : '')
      if (!groupsChanged && !searchChanged) return
      if (groupsChanged) graph.options.colorGroups = groups
      if (searchChanged) graph.options.search = search
      graph.saveOptions()
      for (const leaf of this.app.workspace.getLeavesOfType('graph')) {
        (leaf.view as unknown as GraphViewLike).dataEngine?.setOptions?.({ ...(groupsChanged ? { colorGroups: groups as ColorGroup[] } : {}), ...(searchChanged ? { search } : {}) })
      }
      return
    }
    // graph plugin not loaded: edit its settings file, so the colors and filter are there when it is
    const path = normalizePath(`${this.app.vault.configDir}/graph.json`)
    let cur: Record<string, unknown> = {}
    try { cur = JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, unknown> } catch { /* no file yet */ }
    const groups = keepGroups ? cur.colorGroups : mergeColorGroups(cur.colorGroups, ours)
    const search = withArchiveFilter(cur.search, hide)
    const groupsChanged = !keepGroups && !sameGroups(cur.colorGroups, groups as ColorGroup[])
    if (!groupsChanged && search === (cur.search ?? '')) return
    await this.app.vault.adapter.write(path, JSON.stringify({ ...cur, ...(groupsChanged ? { colorGroups: groups } : {}), search }, null, 2))
  }

  stop() {
    this.stopped = true
    for (const st of this.boards.values()) {
      st.abort?.abort()
      if (st.poll) window.clearInterval(st.poll)
    }
    for (const t of this.timers.values()) window.clearTimeout(t)
    for (const t of this.indexTimers.values()) window.clearTimeout(t)
    window.clearTimeout(this.graphTimer)
    this.boards.clear()
    this.timers.clear()
    this.indexTimers.clear()
  }

  async restart() {
    this.stop()
    await this.start()
  }

  private refreshStatus() {
    if (this.paused) return this.onStatus({ text: 'BoardHydra: ' + this.paused, error: true })
    const all = [...this.boards.values()]
    const live = all.filter((b) => b.live).length
    const rem = this.api.remaining !== null ? ` · ${this.api.remaining} requests left today` : ''
    this.onStatus({ text: all.length && live === all.length ? `BoardHydra: live${rem}` : `BoardHydra: synced${rem}` })
  }

  /** 401/402: stop everything and say why. Returns true if it was one of those. */
  private handleFatal(e: unknown): boolean {
    if (!(e instanceof ApiError)) return false
    if (e.status === 402) {
      this.paused = 'paused — Obsidian sync needs BoardHydra Pro'
      new Notice('BoardHydra: Obsidian sync is part of Pro. Upgrade at boardhydra.com, then choose Sync now.', 10000)
    } else if (e.status === 401) {
      this.paused = 'disconnected — connect again in settings'
      new Notice('BoardHydra: this vault was disconnected. Connect again in the plugin settings.', 10000)
    } else {
      return false
    }
    this.stop()
    this.refreshStatus()
    return true
  }

  // ---------- pull ----------

  private boardFolder(snap: BHSnapshot): string {
    const s = this.s()
    if (!s.folders[snap.board.id]) s.folders[snap.board.id] = safeName(snap.board.name)
    return normalizePath(`${this.root()}/${s.folders[snap.board.id]}`)
  }

  private ctx(st: BoardState): BoardCtx {
    const paths = this.listPaths(st)
    return {
      lists: st.snap.lists, labels: st.snap.labels, members: st.snap.members,
      listLink: (l: BHList) => { const p = paths.get(l.id); return p ? wikiLink(p.replace(/\.md$/, ''), l.name) : l.name },
    }
  }

  /** open list id → its note's path, in board order (names made unique) */
  private listPaths(st: BoardState): Map<string, string> {
    const out = new Map<string, string>()
    const used = new Set<string>()
    for (const l of st.snap.lists.filter((x) => !x.closed).sort((a, b) => a.pos - b.pos)) {
      const base = safeName(l.name)
      let p = ''
      for (let n = 1; !p || used.has(p.toLowerCase()); n++) p = normalizePath(`${st.folder}/${LISTS}/${n === 1 ? base : `${base} (${n})`}.md`)
      used.add(p.toLowerCase())
      out.set(l.id, p)
    }
    return out
  }

  private async ensureFolder(path: string) {
    const parts = normalizePath(path).split('/')
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      const f = this.app.vault.getAbstractFileByPath(p)
      if (!f) await this.app.vault.createFolder(p).catch(() => {})
    }
  }

  async syncBoard(id: string) {
    const snap = await this.api.snapshot(id)
    const prev = this.boards.get(id)
    const st: BoardState = { id, snap, cards: new Map(snap.cards.map((c) => [c.id, c])), notes: new Map((snap.notes ?? []).map((n) => [n.id, n])), folder: this.boardFolder(snap), live: prev?.live ?? false, abort: prev?.abort, poll: prev?.poll }
    this.boards.set(id, st)
    await this.ensureFolder(st.folder)
    // what's already in the vault
    const folder = this.app.vault.getAbstractFileByPath(st.folder)
    const found = new Map<string, TFile[]>()
    if (folder instanceof TFolder) {
      for (const f of folder.children) {
        if (!(f instanceof TFile) || f.extension !== 'md') continue
        const fm = parseNote(await this.app.vault.read(f), yaml).fm
        if (typeof fm.bh_id === 'string') found.set(fm.bh_id, [...(found.get(fm.bh_id) ?? []), f])
      }
    }
    const local = new Map<string, string>()
    for (const [cid, files] of found) local.set(cid, await this.keepOne(st, cid, files))
    for (const [cid, path] of local) this.pathById.set(cid, path)
    for (const c of snap.cards) await this.applyRemote(st, c)
    for (const [cid, path] of local) if (!st.cards.has(cid)) await this.archiveLocal(cid, path)
    // notes on cards
    const nd = this.app.vault.getAbstractFileByPath(this.notesDir(st))
    if (nd instanceof TFolder) {
      for (const f of [...nd.children]) {
        if (!(f instanceof TFile) || f.extension !== 'md') continue
        const fm = parseCardNote(await this.app.vault.read(f), yaml).fm
        if (typeof fm.bh_note !== 'string') continue
        this.notePaths.set(fm.bh_note, f.path)
        if (!st.notes.has(fm.bh_note)) await this.removeLocalNote(fm.bh_note) // deleted in BoardHydra
      }
    }
    await this.makeRequestedLists(st)
    await this.writeIndex(st) // also writes the card notes
    await this.writeGuide(st).catch((e) => console.warn('BoardHydra: AI guide note', e))
    this.refreshStatus()
    this.scheduleGraph()
  }

  /**
   * Two notes for one card (an older plugin could leave the old one behind): keep the one at the card's own
   * name, else the newest, and move the others to the trash (Obsidian's or the system's, so nothing is lost).
   */
  private async keepOne(st: BoardState, cardId: string, files: TFile[]): Promise<string> {
    if (files.length === 1) return files[0].path
    const name = st.cards.get(cardId)?.name
    const own = name ? files.find((f) => f.path === normalizePath(`${st.folder}/${safeName(name)}.md`)) : undefined
    const keep = own ?? [...files].sort((a, b) => b.stat.mtime - a.stat.mtime)[0]
    for (const f of files) {
      if (f === keep) continue
      this.selfDeletes.add(f.path)
      await this.app.fileManager.trashFile(f)
    }
    return keep.path
  }

  /** the card's id written in a note's properties, from Obsidian's cache */
  private noteCardId(f: TAbstractFile | null): unknown {
    return f instanceof TFile ? this.app.metadataCache.getFileCache(f)?.frontmatter?.bh_id : undefined
  }

  /** a note in the board's folder that already carries this card's id */
  private findLocal(st: BoardState, cardId: string): string | undefined {
    const dir = this.app.vault.getAbstractFileByPath(st.folder)
    if (!(dir instanceof TFolder)) return undefined
    return dir.children.find((f) => f instanceof TFile && f.extension === 'md' && this.noteCardId(f) === cardId)?.path
  }

  /** a note in the board's _archive/ folder that carries this card's id */
  private findArchived(st: BoardState, cardId: string): string | undefined {
    const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${st.folder}/${ARCHIVE}`))
    if (!(dir instanceof TFolder)) return undefined
    return dir.children.find((f) => f instanceof TFile && f.extension === 'md' && this.noteCardId(f) === cardId)?.path
  }

  private uniquePath(st: BoardState, name: string, cardId: string): string {
    const base = safeName(name)
    for (let n = 1; ; n++) {
      const p = normalizePath(`${st.folder}/${n === 1 ? base : `${base} (${n})`}.md`)
      const owner = [...this.pathById.entries()].find(([, v]) => v === p)?.[0]
      const f = this.app.vault.getAbstractFileByPath(p)
      if ((!f && !owner) || owner === cardId) return p
      if (!owner && this.noteCardId(f) === cardId) return p // this card's own note, just not tracked yet
    }
  }

  private async write(path: string, text: string) {
    const f = this.app.vault.getAbstractFileByPath(path)
    if (f instanceof TFile) {
      const cur = await this.app.vault.read(f)
      if (cur === text) return
      this.selfWrites.set(path, text)
      await this.app.vault.process(f, () => text)
    } else {
      this.selfWrites.set(path, text)
      await this.app.vault.create(path, text)
    }
  }

  private async move(from: string, to: string) {
    const f = this.app.vault.getAbstractFileByPath(from)
    if (!(f instanceof TFile) || from === to) return
    this.selfMoves.add(to)
    await this.app.fileManager.renameFile(f, to)
  }

  private async applyRemote(st: BoardState, c: BHCard) {
    st.cards.set(c.id, c)
    if (c.closed) {
      const p = this.pathById.get(c.id)
      if (p) await this.archiveLocal(c.id, p)
      return
    }
    if (this.pending.has(c.id)) return // a local edit is on its way up; it carries ifUpdatedAt and settles conflicts
    if (this.archiving.has(c.id)) return // don't bring the note back while its card is being archived
    let path = this.pathById.get(c.id)
    if (!path || !this.app.vault.getAbstractFileByPath(path)) path = this.findLocal(st, c.id) ?? path // never start a second note for a card
    // restored in BoardHydra: bring its note back out of _archive/ (or drop the stale copy if it already has a live one)
    const archived = this.findArchived(st, c.id)
    if (archived) {
      if (path && this.app.vault.getAbstractFileByPath(path)) {
        this.selfDeletes.add(archived)
        const f = this.app.vault.getAbstractFileByPath(archived)
        if (f instanceof TFile) await this.app.fileManager.trashFile(f)
      } else {
        path = this.uniquePath(st, c.name, c.id)
        await this.move(archived, path)
      }
    }
    const want = this.uniquePath(st, c.name, c.id)
    if (path && this.app.vault.getAbstractFileByPath(path) && path !== want && !path.endsWith(`/${safeName(c.name)}.md`)) {
      await this.move(path, want) // renamed in BoardHydra
      path = want
    }
    if (!path || !this.app.vault.getAbstractFileByPath(path)) path = want
    this.pathById.set(c.id, path)
    const f = this.app.vault.getAbstractFileByPath(path)
    const existing = f instanceof TFile ? parseNote(await this.app.vault.read(f), yaml).fm : {} // keep the user's own properties and tags
    await this.write(path, renderCard(c, this.ctx(st), yaml, existing))
  }

  private async archiveLocal(cardId: string, path: string) {
    this.pathById.delete(cardId)
    const f = this.app.vault.getAbstractFileByPath(path)
    if (!(f instanceof TFile)) return
    const dir = normalizePath(`${f.parent?.path ?? this.root()}/${ARCHIVE}`)
    await this.ensureFolder(dir)
    let to = normalizePath(`${dir}/${f.name}`)
    for (let n = 2; this.app.vault.getAbstractFileByPath(to); n++) to = normalizePath(`${dir}/${f.basename} (${n}).md`)
    await this.move(path, to)
    // an archived card hangs off the board's "Archived cards" note instead of its old list
    const moved = this.app.vault.getAbstractFileByPath(to)
    if (moved instanceof TFile) await this.markArchived(moved, wikiLink(`${dir}/${ARCHIVE_NOTE}`, ARCHIVE_NOTE))
  }

  private async markArchived(f: TFile, link: string) {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter
    if (fm && fm.list === link && fm.archived === true) return
    await this.app.fileManager.processFrontMatter(f, (m: Record<string, unknown>) => {
      m.list = link
      m.archived = true
    }).catch(() => {})
  }

  /** <board>/_archive/Archived cards.md, linking the board to every archived card note (removed when there are none). */
  private async writeArchive(st: BoardState, boardLink: string) {
    const dir = normalizePath(`${st.folder}/${ARCHIVE}`)
    const path = normalizePath(`${dir}/${ARCHIVE_NOTE}.md`)
    const link = wikiLink(path.replace(/\.md$/, ''), ARCHIVE_NOTE)
    const folder = this.app.vault.getAbstractFileByPath(dir)
    const cards: { link: string }[] = []
    if (folder instanceof TFolder) {
      for (const f of [...folder.children]) {
        if (!(f instanceof TFile) || f.extension !== 'md' || f.path === path) continue
        const id: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.bh_id ?? parseNote(await this.app.vault.read(f), yaml).fm.bh_id
        if (typeof id !== 'string') continue
        const live = st.cards.get(id)
        if (live && !live.closed) continue // restored on the board: applyRemote moves its note back out
        await this.markArchived(f, link)
        cards.push({ link: wikiLink(f.path.replace(/\.md$/, ''), f.basename) })
      }
    }
    if (cards.length) await this.write(path, renderArchiveNote(st.id, boardLink, cards))
    else {
      const old = this.app.vault.getAbstractFileByPath(path)
      if (old instanceof TFile) await this.app.fileManager.trashFile(old)
    }
  }

  /** <board>/_AI guide.md: the server's guide for AI, refreshed at most every GUIDE_EVERY; removed when turned off. */
  private async writeGuide(st: BoardState) {
    const path = normalizePath(`${st.folder}/${GUIDE}.md`)
    if (!this.s().guide) {
      const old = this.app.vault.getAbstractFileByPath(path)
      if (old instanceof TFile) await this.app.fileManager.trashFile(old)
      return
    }
    const at = this.guideAt.get(st.id) ?? 0
    if (Date.now() - at < GUIDE_EVERY && this.app.vault.getAbstractFileByPath(path)) return
    const md = await this.api.guide(st.id)
    this.guideAt.set(st.id, Date.now())
    const boardPath = this.boardNotePath(st)
    await this.write(path, renderGuideNote(st.id, wikiLink(boardPath.replace(/\.md$/, ''), st.snap.board.name), md))
  }

  /** the board's own note: BoardHydra/<board>.md, linking to its lists */
  private boardNotePath(st: BoardState) {
    return normalizePath(`${this.root()}/${this.s().folders[st.id]}.md`)
  }

  /** the optional Kanban-plugin note (links to every card, so it's off by default to keep the graph a tree) */
  private indexPath(st: BoardState) {
    return normalizePath(`${st.folder}/${KANBAN}.md`)
  }

  private notesDir(st: BoardState) {
    return normalizePath(`${st.folder}/${NOTES}`)
  }

  private cardLink(st: BoardState, cardId: string): string {
    const c = st.cards.get(cardId)
    const p = this.pathById.get(cardId)
    return p ? wikiLink(p.replace(/\.md$/, ''), c?.name ?? '') : c?.name ?? ''
  }

  private async applyRemoteNote(st: BoardState, n: BHNote) {
    st.notes.set(n.id, n)
    if (this.pendingNotes.has(n.id)) return
    const name = n.memberName || 'Someone'
    let path = this.notePaths.get(n.id)
    if (!path || !this.app.vault.getAbstractFileByPath(path)) {
      await this.ensureFolder(this.notesDir(st))
      const base = noteFileName(n, st.cards.get(n.idCard)?.name ?? 'card')
      path = normalizePath(`${this.notesDir(st)}/${base}.md`)
      for (let k = 2; this.app.vault.getAbstractFileByPath(path) && ![...this.notePaths.entries()].some(([id, p]) => id === n.id && p === path); k++) {
        path = normalizePath(`${this.notesDir(st)}/${base} (${k}).md`)
      }
    }
    this.notePaths.set(n.id, path)
    const f = this.app.vault.getAbstractFileByPath(path)
    const existing = f instanceof TFile ? parseCardNote(await this.app.vault.read(f), yaml).fm : {}
    await this.write(path, renderCardNote(n, this.cardLink(st, n.idCard), wikiLink(safeName(name), name), yaml, existing))
  }

  private async removeLocalNote(id: string) {
    const p = this.notePaths.get(id)
    this.notePaths.delete(id)
    for (const st of this.boards.values()) st.notes.delete(id)
    const f = p ? this.app.vault.getAbstractFileByPath(p) : null
    if (f instanceof TFile) {
      this.selfDeletes.add(f.path)
      await this.app.fileManager.trashFile(f)
    }
  }

  /** Starts a new note on the card shown in `cardPath`; returns the new file's path. */
  async newNoteFor(cardPath: string): Promise<string | null> {
    const st = this.boardForPath(cardPath)
    const id = this.idForPath(cardPath)
    const card = id ? st?.cards.get(id) : undefined
    if (!st || !card) return null
    await this.ensureFolder(this.notesDir(st))
    const base = safeName(`${this.me?.name || 'Me'} – ${card.name} (new)`)
    let path = normalizePath(`${this.notesDir(st)}/${base}.md`)
    for (let k = 2; this.app.vault.getAbstractFileByPath(path); k++) path = normalizePath(`${this.notesDir(st)}/${base} (${k}).md`)
    const text = `---\n${yaml.stringify({ bh_card: card.id, card: this.cardLink(st, card.id) }).trimEnd()}\n---\n`
    this.selfWrites.set(path, text)
    await this.app.vault.create(path, text)
    return path
  }

  /** Board note → list notes → cards (cards link back through `list:`), plus the Kanban note if turned on. */
  private async writeIndex(st: BoardState) {
    const cards = [...st.cards.values()].filter((c) => !c.closed && this.pathById.has(c.id)).sort(cardOrder)
    const link = (p: string, label: string) => wikiLink(p.replace(/\.md$/, ''), label)
    const paths = this.listPaths(st)
    const lists = st.snap.lists.filter((l) => paths.has(l.id)).sort((a, b) => a.pos - b.pos)
    const boardPath = this.boardNotePath(st)
    await this.write(boardPath, renderBoardNote(st.id, st.snap.board.name, st.snap.board.desc ?? '', lists.map((l) => ({ link: link(paths.get(l.id)!, l.name) }))))
    await this.ensureFolder(`${st.folder}/${LISTS}`)
    // list notes for lists that are gone or renamed. Removed first: on Windows and macOS "DONE.md" and "Done.md"
    // are the same file, so an archived "DONE" list would block the note of a new "Done" list.
    const keep = new Set(paths.values())
    const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${st.folder}/${LISTS}`))
    if (dir instanceof TFolder) {
      for (const f of [...dir.children]) {
        if (!(f instanceof TFile) || keep.has(f.path)) continue
        if (parseNote(await this.app.vault.read(f), yaml).fm.bh_kind === 'list') await this.app.fileManager.trashFile(f)
      }
    }
    for (const l of lists) {
      const inList = cards.filter((c) => c.idList === l.id).map((c) => ({ link: link(this.pathById.get(c.id)!, c.name), done: c.dueComplete }))
      // one list note that can't be written shouldn't stop the checklists and archive below
      await this.write(paths.get(l.id)!, renderListNote(st.id, l, link(boardPath, st.snap.board.name), inList))
        .catch((e) => console.warn('BoardHydra: list note', l.name, e))
    }
    for (const n of st.notes.values()) await this.applyRemoteNote(st, n) // keeps card links current after renames
    await this.writeChecklists(st, cards)
    await this.writeArchive(st, link(boardPath, st.snap.board.name))
    if (this.s().kanban) {
      await this.write(this.indexPath(st), renderIndex(st.id, st.snap.lists, cards, (c) => this.pathById.get(c.id)!.replace(/\.md$/, '')))
    }
  }

  /** Checklist and item notes for the graph; removes the ones whose checklist, item or card is gone. */
  private async writeChecklists(st: BoardState, cards: BHCard[]) {
    const root = normalizePath(`${st.folder}/${CHECKLISTS}`)
    const keep = new Set<string>()
    if (this.s().checklists) {
      for (const c of cards) {
        if (!c.checklists?.length) continue
        const cardPath = this.pathById.get(c.id)!
        const dir = `${root}/${cardPath.replace(/\.md$/, '').split('/').pop()}`
        const files = checklistNotes(c, dir, this.cardLink(st, c.id), yaml)
        for (const f of files) {
          const p = normalizePath(f.path)
          keep.add(p)
          await this.ensureFolder(p.slice(0, p.lastIndexOf('/')))
          await this.write(p, f.text)
        }
      }
    }
    const top = this.app.vault.getAbstractFileByPath(root)
    if (top instanceof TFolder) await this.prune(top, keep)
  }

  /** Deletes generated checklist notes not in `keep`, then folders left empty. Your own files stay. */
  private async prune(dir: TFolder, keep: Set<string>) {
    for (const f of [...dir.children]) {
      if (f instanceof TFolder) { await this.prune(f, keep); continue }
      if (!(f instanceof TFile) || f.extension !== 'md' || keep.has(f.path)) continue
      const kind: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.bh_kind ?? parseNote(await this.app.vault.read(f), yaml).fm.bh_kind
      if (kind === 'checklist' || kind === 'checkitem') await this.app.fileManager.trashFile(f)
    }
    if (!dir.children.length) await this.app.fileManager.trashFile(dir).catch(() => {})
  }

  private scheduleIndex(st: BoardState) {
    const t = this.indexTimers.get(st.id)
    if (t) window.clearTimeout(t)
    this.indexTimers.set(st.id, window.setTimeout(() => { this.indexTimers.delete(st.id); this.writeIndex(st).catch(() => {}) }, 500))
  }

  private async rerender(st: BoardState) {
    for (const c of st.cards.values()) if (!c.closed) await this.applyRemote(st, c)
    this.scheduleIndex(st)
  }

  // ---------- live events ----------

  private openStream(id: string) {
    const st = this.boards.get(id)
    if (!st || this.stopped) return
    st.abort?.abort()
    const ac = new AbortController()
    st.abort = ac
    let delay = 3000
    let failures = 0
    const run = async () => {
      while (!ac.signal.aborted && !this.stopped) {
        let opened = false
        try {
          await this.api.stream(id, ac.signal, () => {
            opened = true
            const cur = this.boards.get(id)
            if (cur) cur.live = true
            this.refreshStatus()
          }, (ev) => { this.enqueue(id, () => this.onEvent(id, ev)).catch(() => {}) })
        } catch (e) {
          if (ac.signal.aborted) return
          if (this.handleFatal(e)) return
          if (e instanceof ApiError && e.status === 403) return // lost access to the board
          if (!(e instanceof ApiError)) failures++ // network or CORS: maybe this device can't stream
        }
        const cur = this.boards.get(id)
        if (cur) cur.live = false
        this.refreshStatus()
        if (failures >= 3) return this.startPolling(id)
        if (opened) { delay = 3000; failures = 0 }
        await new Promise((r) => window.setTimeout(r, delay))
        delay = Math.min(delay * 2, 60000)
        if (ac.signal.aborted || this.stopped) return
        // events missed while disconnected aren't replayed: reload the board once
        try { await this.enqueue(id, () => this.syncBoard(id)) } catch (e) { if (this.handleFatal(e)) return }
      }
    }
    void run()
  }

  /** Fallback when this device can't hold a stream open: reload every 15 minutes. */
  private startPolling(id: string) {
    const st = this.boards.get(id)
    if (!st || st.poll) return
    st.poll = window.setInterval(() => { this.syncBoard(id).catch((e) => this.handleFatal(e)) }, 15 * 60 * 1000)
  }

  private async onEvent(boardId: string, ev: BHEvent) {
    const st = this.boards.get(boardId)
    if (!st || ev.origin === this.s().clientId) return // our own writes are applied from their responses
    switch (ev.type) {
      case 'card':
        if (ev.op === 'delete') {
          st.cards.delete(ev.data.id)
          const p = this.pathById.get(ev.data.id)
          if (p) await this.archiveLocal(ev.data.id, p)
        } else {
          await this.applyRemote(st, ev.data as BHCard)
        }
        this.scheduleIndex(st)
        break
      case 'note':
        if (ev.op === 'delete') await this.removeLocalNote(ev.data.id)
        else await this.applyRemoteNote(st, ev.data as BHNote)
        break
      case 'list':
        st.snap.lists = st.snap.lists.filter((l) => l.id !== ev.data.id)
        if (ev.op === 'upsert') st.snap.lists.push(ev.data as BHList)
        await this.rerender(st)
        break
      case 'label':
        st.snap.labels = st.snap.labels.filter((l) => l.id !== ev.data.id)
        if (ev.op === 'upsert') st.snap.labels.push(ev.data as BHLabel)
        await this.rerender(st)
        this.scheduleGraph()
        break
      case 'members':
      case 'board':
        if (ev.op === 'delete' && ev.type === 'board') { st.abort?.abort(); this.boards.delete(boardId); break }
        await this.syncBoard(boardId)
        break
    }
  }

  // ---------- push (local edits) ----------

  private boardForPath(path: string): BoardState | undefined {
    for (const st of this.boards.values()) {
      if (path.startsWith(st.folder + '/') && !path.slice(st.folder.length + 1).includes('/')) return st
    }
    return undefined
  }

  private boardForNotePath(path: string): BoardState | undefined {
    for (const st of this.boards.values()) {
      const dir = this.notesDir(st)
      if (path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/')) return st
    }
    return undefined
  }

  private boardForListPath(path: string): BoardState | undefined {
    for (const st of this.boards.values()) {
      const dir = normalizePath(`${st.folder}/${LISTS}`)
      if (path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/')) return st
    }
    return undefined
  }

  private noteIdForPath(path: string): string | undefined {
    for (const [id, p] of this.notePaths) if (p === path) return id
    return undefined
  }

  private boardForIndex(path: string): BoardState | undefined {
    if (!this.s().kanban) return undefined
    for (const st of this.boards.values()) if (this.indexPath(st) === path) return st
    return undefined
  }

  private idForPath(path: string): string | undefined {
    for (const [id, p] of this.pathById) if (p === path) return id
    return undefined
  }

  /** modify / create events */
  onLocalChange(f: TAbstractFile) {
    if (this.stopped || this.paused || !(f instanceof TFile) || f.extension !== 'md') return
    const own = this.selfWrites.get(f.path)
    if (own !== undefined) {
      this.app.vault.read(f).then((t) => {
        if (t === own) this.selfWrites.delete(f.path)
        else { this.selfWrites.delete(f.path); this.schedule(f.path) }
      }).catch(() => this.selfWrites.delete(f.path))
      return
    }
    this.schedule(f.path)
  }

  private schedule(path: string) {
    const idx = this.boardForIndex(path)
    const noteSt = idx ? undefined : this.boardForNotePath(path)
    const listSt = idx || noteSt ? undefined : this.boardForListPath(path)
    const st = idx || noteSt || listSt ? undefined : this.boardForPath(path)
    if (!st && !idx && !noteSt && !listSt) return
    const id = st ? this.idForPath(path) : undefined
    if (id) this.pending.add(id)
    const noteId = noteSt ? this.noteIdForPath(path) : undefined
    if (noteId) this.pendingNotes.add(noteId)
    const t = this.timers.get(path)
    if (t) window.clearTimeout(t)
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path)
      const run = idx ? this.pushIndex(idx) : noteSt ? this.pushNote(noteSt, path) : listSt ? this.pushListNote(listSt, path) : this.push(path)
      run.catch((e) => {
        if (this.handleFatal(e)) return
        new Notice('BoardHydra: ' + (e as Error).message)
      }).finally(() => {
        if (id) this.pending.delete(id)
        if (noteId) this.pendingNotes.delete(noteId)
      })
    }, PUSH_DELAY))
  }

  private async push(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path)
    const st = this.boardForPath(path)
    if (!(f instanceof TFile) || !st) return
    if (this.creating.has(path)) { this.schedule(path); return }
    const text = await this.app.vault.read(f)
    const parsed = parseNote(text, yaml)
    const id = typeof parsed.fm.bh_id === 'string' ? parsed.fm.bh_id : ''
    const card = id ? st.cards.get(id) ?? null : null
    if (id && !card) return // not on this board any more (archived or moved); nothing to update
    if (!id && !text.trim()) return // a fresh empty note: wait until it has something
    if (!id && f.basename.startsWith('_')) return // the plugin's own notes (_Kanban) are never cards
    const read = () => holdPinned(noteToPatch(parsed, f.basename, card, this.ctx(st), genId), card)
    let result = read()
    if (this.s().createFromNotes !== false && (result.missing.list || result.missing.labels.length)) {
      // lists and labels the note names but the board lacks: make them, then read the note again
      await this.makeMissing(st, result.missing)
      result = read()
    }
    const { patch, warnings, held } = result
    if (warnings.length) new Notice('BoardHydra: ' + warnings.join(' · '), 8000)

    if (!card) {
      const open = st.snap.lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos)
      const idList = patch.idList ?? open[0]?.id
      if (!idList) return
      const { pinned, ...fields } = patch // a card can't be created pinned: create it, then pin it
      this.creating.add(path)
      try {
        let created = await this.api.createCard(st.id, { ...fields, idList, name: patch.name ?? f.basename })
        this.pathById.set(created.id, path)
        try {
          if (pinned) {
            const sent = await this.sendPatch(st, created, { pinned })
            created = sent.card
            if (sent.reasons.length) new Notice(`BoardHydra: added “${created.name}” without a pin — ${sent.reasons.join(' · ')}`, 12000)
          }
        } finally {
          // even if pinning failed, the note must get its card's id, or the next save would make a second card
          await this.applyRemote(st, created)
          this.scheduleIndex(st)
        }
      } finally {
        this.creating.delete(path)
      }
      return
    }

    const heldNotice = () => { if (held) new Notice(`BoardHydra: “${card.name}” is pinned. Set \`pinned: false\` to move it.`, 10000) }
    if (!Object.keys(patch).length) {
      // nothing the card holds changed (maybe only spacing): leave the note alone, unless a move was held back
      if (held) {
        this.pending.delete(card.id)
        await this.applyRemote(st, st.cards.get(card.id) ?? card)
        heldNotice()
      }
      return
    }
    const ifUpdatedAt = typeof parsed.fm.bh_updated === 'string' ? parsed.fm.bh_updated : card.dateLastActivity
    try {
      const { card: updated, refused, reasons } = await this.sendPatch(st, card, { ...patch, ifUpdatedAt })
      const lostText = refused.some((k) => TEXT_FIELDS.includes(k))
      if (lostText) await this.saveConflict(st, f, text)
      this.pending.delete(card.id)
      await this.applyRemote(st, updated)
      if (held || refused.length || patch.idList || patch.name || patch.dueComplete !== undefined || patch.pinned !== undefined) this.scheduleIndex(st)
      heldNotice()
      if (reasons.length) new Notice(`BoardHydra: “${card.name}”: ${reasons.join(' · ')}. That change was undone${lostText ? `; your version is in ${CONFLICTS}/` : ''}.`, 12000)
    } catch (e) {
      const theirs = e instanceof ApiError && e.status === 409 ? (e.body as { card?: BHCard } | null)?.card : undefined
      if (!theirs) throw e
      await this.saveConflict(st, f, text)
      this.pending.delete(card.id)
      await this.applyRemote(st, theirs)
      new Notice(`BoardHydra: “${card.name}” changed in BoardHydra too. Your version is in ${CONFLICTS}/ — the note now shows the BoardHydra version.`, 12000)
    }
  }

  /**
   * Sends a card change. If the server refuses it (no permission, pinned, waiting for sign-offs, no pin left), its
   * parts are sent one by one, so what is allowed still lands. A conflict and every other error are thrown.
   */
  private async sendPatch(st: BoardState, card: BHCard, patch: CardPatch): Promise<Sent> {
    const known = () => st.cards.get(card.id) ?? card
    const groups = splitPatch(patch)
    try {
      return { card: await this.api.updateCard(card.id, patch), refused: [], reasons: [] }
    } catch (e) {
      const why = await this.refusal(e, patch)
      if (groups.length < 2) return { card: known(), refused: groups.flatMap((g) => Object.keys(g)), reasons: [why] }
    }
    const refused: string[] = []
    const reasons = new Set<string>()
    let seen = patch.ifUpdatedAt
    let landed: BHCard | undefined
    for (const group of groups) {
      try {
        landed = await this.api.updateCard(card.id, seen === undefined ? group : { ...group, ifUpdatedAt: seen })
        if (seen !== undefined) seen = landed.dateLastActivity
      } catch (e) {
        reasons.add(await this.refusal(e, group))
        refused.push(...Object.keys(group))
      }
    }
    return { card: landed ?? known(), refused, reasons: [...reasons] }
  }

  /** The server's reason when it refused this change (so nothing changed); any other error is thrown on. */
  private async refusal(e: unknown, patch: CardPatch): Promise<string> {
    if (!(e instanceof ApiError)) throw e
    const conflict = e.status === 409 && !!(e.body as { card?: BHCard } | null)?.card
    if (e.status === 403 || e.status === 422 || (e.status === 409 && !conflict)) return e.message
    if (e.status !== 402 || patch.pinned !== true) throw e
    // 402 means "no pin left", but also "Pro lapsed", which answers every call that way: only that stops the sync
    try {
      await this.api.me()
    } catch (me) {
      if (me instanceof ApiError && (me.status === 401 || me.status === 402)) throw me
    }
    return e.message
  }

  private async saveConflict(st: BoardState, f: TFile, text: string) {
    const dir = normalizePath(`${st.folder}/${CONFLICTS}`)
    await this.ensureFolder(dir)
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    const body = text.replace(/^bh_id:.*$/m, '').replace(/^bh_updated:.*$/m, '') // a conflict copy is never a card
    const base = `${dir}/${f.basename} (conflict ${stamp}`
    let path = normalizePath(`${base}).md`)
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${base}, ${n}).md`)
    await this.app.vault.create(path, body)
  }

  /** Cards dragged between lists (or reordered, or ticked) in the board's Kanban note. */
  private async pushIndex(st: BoardState) {
    const f = this.app.vault.getAbstractFileByPath(this.indexPath(st))
    if (!(f instanceof TFile)) return
    const text = await this.app.vault.read(f)
    const checked = new Map<string, boolean>()
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*[-*] \[([ xX])\] .*?\[\[([^\]|]+)/.exec(line)
      if (m) checked.set(m[2].trim(), m[1] !== ' ')
    }
    const byTarget = new Map<string, BHCard>()
    for (const c of st.cards.values()) {
      const p = this.pathById.get(c.id)
      if (p) {
        byTarget.set(p.replace(/\.md$/, ''), c)
        byTarget.set(p.replace(/\.md$/, '').split('/').pop()!, c)
      }
    }
    const { moves, held } = planIndexMoves(st.snap.lists, parseIndex(text), byTarget, checked)
    const failed: string[] = []
    try {
      for (const m of moves) {
        const card = st.cards.get(m.id)
        if (!card) continue
        try {
          const sent = await this.sendPatch(st, card, m.patch)
          await this.applyRemote(st, sent.card)
          if (sent.reasons.length) failed.push(`“${card.name}”: ${sent.reasons.join(' · ')}`)
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 402)) throw e
          failed.push(`“${card.name}”: ${(e as Error).message}`) // one card that can't change doesn't stop the others
        }
      }
      if (held.length) new Notice(`BoardHydra: pinned cards stay in their list (${held.map((n) => `“${n}”`).join(', ')}). Set \`pinned: false\` in a card’s note to move it.`, 10000)
      if (failed.length) new Notice(`BoardHydra: ${failed.join('; ')}`, 12000)
    } finally {
      this.scheduleIndex(st) // the Kanban note shows what BoardHydra has again
    }
  }

  /** A note in <board>/Notes changed: send its text up (your own notes), or start a new one on its card. */
  private async pushNote(st: BoardState, path: string) {
    const f = this.app.vault.getAbstractFileByPath(path)
    if (!(f instanceof TFile)) return
    const { fm, body } = parseCardNote(await this.app.vault.read(f), yaml)
    const id = typeof fm.bh_note === 'string' ? fm.bh_note : ''
    if (id) {
      const n = st.notes.get(id)
      if (!n || body === n.body.trim()) return
      if (!body) return // emptied: delete the file to delete the note
      if (n.idMember !== this.me?.id) {
        this.pendingNotes.delete(id)
        await this.applyRemoteNote(st, n)
        new Notice(`BoardHydra: only ${n.memberName || 'its author'} can edit that note. Your change was undone.`, 8000)
        return
      }
      const updated = await this.api.updateNote(id, body)
      this.pendingNotes.delete(id)
      await this.applyRemoteNote(st, updated)
      return
    }
    if (!body || this.creating.has(path)) return
    // which card: bh_card, else the card link, else a card with that name
    let cardId = typeof fm.bh_card === 'string' && st.cards.has(fm.bh_card) ? fm.bh_card : ''
    if (!cardId) {
      const target = linkTarget(fm.card)
      cardId = [...this.pathById.entries()].find(([cid, p]) => st.cards.has(cid) && (p.replace(/\.md$/, '') === target || p.replace(/\.md$/, '').endsWith('/' + target)))?.[0] ?? ''
      if (!cardId && target) cardId = [...st.cards.values()].find((c) => c.name === unlink(String(fm.card)))?.id ?? ''
    }
    if (!cardId) {
      new Notice('BoardHydra: to share this note, add a card: property linking to the card (or use “Add a note to this card”).', 8000)
      return
    }
    this.creating.add(path)
    try {
      const created = await this.api.createNote(cardId, body)
      this.notePaths.set(created.id, path)
      await this.applyRemoteNote(st, created)
    } finally {
      this.creating.delete(path)
    }
  }

  // ---------- lists and labels made from notes ----------

  /** Creates the lists and labels a card note names that the board lacks (when the setting is on). */
  private async makeMissing(st: BoardState, missing: Missing) {
    if (missing.list) await this.ensureList(st, missing.list)
    for (const l of missing.labels) await this.ensureLabel(st, l.name, l.color)
  }

  /**
   * One create per board and name at a time (a list note and its cards often arrive together), and only one try
   * after the server refuses. Sign-in and plan errors still stop the sync.
   */
  private async once<T>(key: string, what: string, make: () => Promise<T>): Promise<T | undefined> {
    if (this.refused.has(key)) return undefined
    const running = this.making.get(key) as Promise<T | undefined> | undefined
    if (running) return running
    const job = make().catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 402)) throw e
      this.refused.add(key)
      new Notice(`BoardHydra: couldn’t create ${what} — ${(e as Error).message}`, 8000)
      return undefined
    }).finally(() => this.making.delete(key))
    this.making.set(key, job)
    return job
  }

  /** The open list with this name (any case), created at the end of the board if there isn't one. */
  private async ensureList(st: BoardState, name: string): Promise<BHList | undefined> {
    const find = () => st.snap.lists.find((l) => !l.closed && l.name.toLowerCase() === name.toLowerCase())
    const have = find()
    if (have) return have
    return this.once(`${st.id}:list:${name.toLowerCase()}`, `the list “${name}”`, async () => {
      const again = find()
      if (again) return again
      const l = await this.api.createList(st.id, name)
      // our own event is skipped (its origin is us), so add the list here
      st.snap.lists = [...st.snap.lists.filter((x) => x.id !== l.id), l]
      this.scheduleIndex(st)
      new Notice(`BoardHydra: added the list “${l.name}”.`)
      return l
    })
  }

  /** The label whose tag matches this name's, created (in `color`, or a free one the board doesn't use) if missing. */
  private async ensureLabel(st: BoardState, name: string, color?: string): Promise<BHLabel | undefined> {
    const tag = labelTag({ name } as BHLabel).toLowerCase()
    const find = () => st.snap.labels.find((l) => labelTag(l).toLowerCase() === tag)
    const have = find()
    if (have) return have
    return this.once(`${st.id}:label:${tag}`, `the label “${name}”`, async () => {
      const again = find()
      if (again) return again
      let c = color
      if (c && !LABEL_COLORS.includes(c)) {
        new Notice(`BoardHydra: “${c}” isn’t a label color anyone can use; the label “${name}” gets another one.`, 8000)
        c = undefined
      }
      const l = await this.api.createLabel(st.id, name, c ?? pickLabelColor(st.snap.labels))
      st.snap.labels = [...st.snap.labels.filter((x) => x.id !== l.id), l]
      this.scheduleGraph()
      new Notice(`BoardHydra: added the label “${l.name}”.`)
      return l
    })
  }

  /** A note in <board>/Lists/ that isn't one of ours asks for a list: make it, then the note becomes its list note. */
  private async pushListNote(st: BoardState, path: string) {
    if (this.s().createFromNotes === false) return
    const f = this.app.vault.getAbstractFileByPath(path)
    if (f instanceof TFile) await this.makeRequestedList(st, f)
  }

  private async makeRequestedList(st: BoardState, f: TFile) {
    if (f.extension !== 'md') return
    const name = listRequestName(await this.app.vault.read(f), f.basename, yaml)
    if (!name) return
    const list = await this.ensureList(st, name)
    if (!list) return
    // the list note is written at the list's own path; a request note anywhere else is no longer needed
    const target = this.listPaths(st).get(list.id)
    if (target && target !== f.path && this.app.vault.getAbstractFileByPath(f.path)) {
      this.selfDeletes.add(f.path)
      await this.app.fileManager.trashFile(f)
    }
    this.scheduleIndex(st)
  }

  /** Request notes already in Lists/ when the board loads (written while Obsidian was closed). */
  private async makeRequestedLists(st: BoardState) {
    if (this.s().createFromNotes === false) return
    const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${st.folder}/${LISTS}`))
    if (!(dir instanceof TFolder)) return
    for (const f of [...dir.children]) {
      if (!(f instanceof TFile)) continue
      try {
        await this.makeRequestedList(st, f)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 402)) throw e // the caller stops the sync
        console.warn('BoardHydra: list request note', f.path, e)
      }
    }
  }

  onLocalRename(f: TAbstractFile, oldPath: string) {
    if (!(f instanceof TFile)) return
    if (this.selfMoves.delete(f.path)) return
    const nid = this.noteIdForPath(oldPath)
    if (nid) { this.notePaths.set(nid, f.path); return }
    const id = this.idForPath(oldPath)
    if (id) this.pathById.set(id, f.path)
    if (this.boardForPath(f.path) || this.boardForListPath(f.path)) this.schedule(f.path)
    else if (id && f.path.includes(`/${ARCHIVE}/`)) this.archiveRemote(id)
  }

  onLocalDelete(f: TAbstractFile) {
    if (!(f instanceof TFile)) return
    if (this.selfDeletes.delete(f.path)) return
    const nid = this.noteIdForPath(f.path)
    if (nid) {
      this.notePaths.delete(nid)
      if (this.stopped || this.paused) return
      this.api.deleteNote(nid).then(() => {
        for (const st of this.boards.values()) st.notes.delete(nid)
      }).catch((e) => {
        if (this.handleFatal(e)) return
        new Notice('BoardHydra: ' + (e as Error).message + ' It will come back at the next sync.', 8000)
      })
      return
    }
    const id = this.idForPath(f.path)
    if (!id) return
    this.pathById.delete(id)
    this.archiveRemote(id)
  }

  /**
   * A note deleted (or moved to _archive) in the vault archives its card; nothing is deleted in BoardHydra.
   * A pinned card is asked about first, as in BoardHydra.
   */
  private archiveRemote(id: string) {
    if (this.stopped || this.paused) return
    for (const st of this.boards.values()) {
      const c = st.cards.get(id)
      if (!c || c.closed) continue
      this.pathById.delete(id) // the note has left the board's folder, whatever happens next
      this.pending.delete(id)
      this.archiving.add(id)
      this.settleArchive(st.id, c)
        .catch((e) => { if (!this.handleFatal(e)) new Notice(`BoardHydra: ${(e as Error).message}. “${c.name}” comes back at the next sync.`, 8000) })
        .finally(() => this.archiving.delete(id))
    }
  }

  /** Archives the card, or brings its note back if the user keeps it or may not archive it. */
  private async settleArchive(boardId: string, card: BHCard) {
    const keep = !!card.pinned && !(await confirmArchive(this.app, card.name))
    if (this.stopped || this.paused) return
    let archived: BHCard | undefined
    if (!keep) {
      try {
        archived = await this.api.updateCard(card.id, { closed: true })
        new Notice(`BoardHydra: archived “${card.name}”${card.pinned ? ' and removed its pin' : ''}. Restore it from the board’s archive in BoardHydra.`)
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e
        new Notice(`BoardHydra: “${card.name}” wasn’t archived — ${e.message}`, 10000)
      }
    }
    await this.enqueue(boardId, async () => {
      this.archiving.delete(card.id)
      const st = this.boards.get(boardId) // the board may have been loaded again while we waited
      if (!st) return
      if (archived) {
        const back = this.findLocal(st, card.id) // moved back, or written again, while we waited
        if (back) this.pathById.set(card.id, back)
        await this.applyRemote(st, archived)
      } else {
        // without its old path, applyRemote moves the note back out of _archive/ (or writes a deleted one again).
        // With it, a live note plus an archived copy would look like a leftover, and the moved note would be trashed
        this.pathById.delete(card.id)
        this.pending.delete(card.id)
        const now = st.cards.get(card.id)
        if (now) await this.applyRemote(st, now)
      }
      this.scheduleIndex(st)
    })
  }
}
