import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian'
import { Api, ApiError } from './api'
import { BoardCtx, Yaml, noteToPatch, parseIndex, parseNote, posBetween, renderCard, renderIndex, safeName } from './format'
import type { BHCard, BHEvent, BHSnapshot, CardPatch } from './types'

export interface Settings {
  server: string
  key: string
  vault: string
  userName: string
  boards: string[] // board ids to sync
  root: string // vault folder for everything
  folders: Record<string, string> // board id → its folder name (kept when the board is renamed)
  clientId: string
}

const yaml: Yaml = { parse: parseYaml, stringify: stringifyYaml }
const PUSH_DELAY = 2000
const ARCHIVE = '_archive'
const CONFLICTS = '_conflicts'

export function genId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

interface BoardState {
  id: string
  snap: BHSnapshot
  cards: Map<string, BHCard>
  folder: string // full vault path of the board's folder
  abort?: AbortController
  poll?: number
  live: boolean
}

export type Status = { text: string; error?: boolean }

export class SyncEngine {
  private boards = new Map<string, BoardState>()
  private pathById = new Map<string, string>()
  private selfWrites = new Map<string, string>() // path → text we just wrote (its modify event is ours)
  private selfMoves = new Set<string>() // paths we just renamed to
  private timers = new Map<string, number>()
  private pending = new Set<string>() // card ids with local edits waiting to go up
  private creating = new Set<string>() // paths of new notes being created on the server
  private indexTimers = new Map<string, number>()
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

  stop() {
    this.stopped = true
    for (const st of this.boards.values()) {
      st.abort?.abort()
      if (st.poll) window.clearInterval(st.poll)
    }
    for (const t of this.timers.values()) window.clearTimeout(t)
    for (const t of this.indexTimers.values()) window.clearTimeout(t)
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
    return { lists: st.snap.lists, labels: st.snap.labels, members: st.snap.members }
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
    const st: BoardState = { id, snap, cards: new Map(snap.cards.map((c) => [c.id, c])), folder: this.boardFolder(snap), live: prev?.live ?? false, abort: prev?.abort, poll: prev?.poll }
    this.boards.set(id, st)
    await this.ensureFolder(st.folder)
    // what's already in the vault
    const folder = this.app.vault.getAbstractFileByPath(st.folder)
    const local = new Map<string, string>()
    if (folder instanceof TFolder) {
      for (const f of folder.children) {
        if (!(f instanceof TFile) || f.extension !== 'md') continue
        const fm = parseNote(await this.app.vault.read(f), yaml).fm
        if (typeof fm.bh_id === 'string') local.set(fm.bh_id, f.path)
      }
    }
    for (const [cid, path] of local) this.pathById.set(cid, path)
    for (const c of snap.cards) await this.applyRemote(st, c)
    for (const [cid, path] of local) if (!st.cards.has(cid)) await this.archiveLocal(cid, path)
    await this.writeIndex(st)
    this.refreshStatus()
  }

  private uniquePath(st: BoardState, name: string, cardId: string): string {
    const base = safeName(name)
    for (let n = 1; ; n++) {
      const p = normalizePath(`${st.folder}/${n === 1 ? base : `${base} (${n})`}.md`)
      const owner = [...this.pathById.entries()].find(([, v]) => v === p)?.[0]
      const f = this.app.vault.getAbstractFileByPath(p)
      if ((!f && !owner) || owner === cardId) return p
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
    let path = this.pathById.get(c.id)
    const want = this.uniquePath(st, c.name, c.id)
    if (path && this.app.vault.getAbstractFileByPath(path) && path !== want && !path.endsWith(`/${safeName(c.name)}.md`)) {
      await this.move(path, want) // renamed in BoardHydra
      path = want
    }
    if (!path || !this.app.vault.getAbstractFileByPath(path)) path = want
    this.pathById.set(c.id, path)
    await this.write(path, renderCard(c, this.ctx(st), yaml))
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
  }

  private indexPath(st: BoardState) {
    return normalizePath(`${this.root()}/${this.s().folders[st.id]}.md`)
  }

  private async writeIndex(st: BoardState) {
    const cards = [...st.cards.values()].filter((c) => !c.closed && this.pathById.has(c.id))
    const text = renderIndex(st.id, st.snap.lists, cards, (c) => this.pathById.get(c.id)!.replace(/\.md$/, ''))
    await this.write(this.indexPath(st), text)
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
          }, (ev) => { this.onEvent(id, ev).catch(() => {}) })
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
        try { await this.syncBoard(id) } catch (e) { if (this.handleFatal(e)) return }
      }
    }
    run()
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
      case 'list':
        st.snap.lists = st.snap.lists.filter((l) => l.id !== ev.data.id)
        if (ev.op === 'upsert') st.snap.lists.push(ev.data)
        await this.rerender(st)
        break
      case 'label':
        st.snap.labels = st.snap.labels.filter((l) => l.id !== ev.data.id)
        if (ev.op === 'upsert') st.snap.labels.push(ev.data)
        await this.rerender(st)
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

  private boardForIndex(path: string): BoardState | undefined {
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
      })
      return
    }
    this.schedule(f.path)
  }

  private schedule(path: string) {
    const st = this.boardForPath(path)
    const idx = st ? undefined : this.boardForIndex(path)
    if (!st && !idx) return
    const id = this.idForPath(path)
    if (id) this.pending.add(id)
    const t = this.timers.get(path)
    if (t) window.clearTimeout(t)
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path)
      const run = idx ? this.pushIndex(idx) : this.push(path)
      run.catch((e) => {
        if (this.handleFatal(e)) return
        new Notice('BoardHydra: ' + (e as Error).message)
      }).finally(() => {
        if (id) this.pending.delete(id)
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
    const { patch, warnings } = noteToPatch(parsed, f.basename, card, this.ctx(st), genId)
    if (warnings.length) new Notice('BoardHydra: ' + warnings.join(' · '), 8000)

    if (!card) {
      const open = st.snap.lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos)
      const idList = patch.idList ?? open[0]?.id
      if (!idList) return
      this.creating.add(path)
      try {
        const created = await this.api.createCard(st.id, { ...patch, idList, name: patch.name ?? f.basename })
        this.pathById.set(created.id, path)
        await this.applyRemote(st, created)
        this.scheduleIndex(st)
      } finally {
        this.creating.delete(path)
      }
      return
    }

    if (!Object.keys(patch).length) {
      // nothing the card holds changed (maybe only spacing); put the note back in the usual shape quietly
      return
    }
    const sent: CardPatch = { ...patch, ifUpdatedAt: typeof parsed.fm.bh_updated === 'string' ? parsed.fm.bh_updated : card.dateLastActivity }
    try {
      const updated = await this.api.updateCard(card.id, sent)
      this.pending.delete(card.id)
      await this.applyRemote(st, updated)
      if (patch.idList || patch.name || patch.dueComplete !== undefined) this.scheduleIndex(st)
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || !e.body?.card) throw e
      await this.saveConflict(st, f, text)
      this.pending.delete(card.id)
      await this.applyRemote(st, e.body.card as BHCard)
      new Notice(`BoardHydra: “${card.name}” changed in BoardHydra too. Your version is in ${CONFLICTS}/ — the note now shows the BoardHydra version.`, 12000)
    }
  }

  private async saveConflict(st: BoardState, f: TFile, text: string) {
    const dir = normalizePath(`${st.folder}/${CONFLICTS}`)
    await this.ensureFolder(dir)
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    const body = text.replace(/^bh_id:.*$/m, '').replace(/^bh_updated:.*$/m, '') // a conflict copy is never a card
    await this.app.vault.create(normalizePath(`${dir}/${f.basename} (conflict ${stamp}).md`), body)
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
    const lists = st.snap.lists.filter((l) => !l.closed)
    for (const sec of parseIndex(text)) {
      const list = lists.find((l) => l.name === sec.list)
      if (!list) continue // new lists are made in BoardHydra
      const seq = sec.targets.map((t) => ({ t, c: byTarget.get(t) })).filter((x): x is { t: string; c: BHCard } => !!x.c)
      let prev: number | undefined
      for (let i = 0; i < seq.length; i++) {
        const { t, c } = seq[i]
        let next: number | undefined
        for (let j = i + 1; j < seq.length; j++) {
          const n = seq[j].c
          if (n.idList === list.id && (prev === undefined || n.pos > prev)) { next = n.pos; break }
        }
        const inPlace = c.idList === list.id && (prev === undefined || c.pos > prev) && (next === undefined || c.pos < next)
        const p: CardPatch = {}
        if (!inPlace) { p.idList = list.id; p.pos = posBetween(prev, next) }
        const done = checked.get(t)
        if (done !== undefined && done !== c.dueComplete) p.dueComplete = done
        if (Object.keys(p).length) {
          const updated = await this.api.updateCard(c.id, p)
          await this.applyRemote(st, updated)
          prev = updated.pos
        } else {
          prev = c.pos
        }
      }
    }
    this.scheduleIndex(st)
  }

  onLocalRename(f: TAbstractFile, oldPath: string) {
    if (!(f instanceof TFile)) return
    if (this.selfMoves.delete(f.path)) return
    const id = this.idForPath(oldPath)
    if (id) this.pathById.set(id, f.path)
    if (this.boardForPath(f.path)) this.schedule(f.path)
    else if (id && f.path.includes(`/${ARCHIVE}/`)) this.archiveRemote(id)
  }

  onLocalDelete(f: TAbstractFile) {
    if (!(f instanceof TFile)) return
    const id = this.idForPath(f.path)
    if (!id) return
    this.pathById.delete(id)
    this.archiveRemote(id)
  }

  /** A note deleted (or moved to _archive) in the vault archives its card; nothing is deleted in BoardHydra. */
  private archiveRemote(id: string) {
    if (this.stopped || this.paused) return
    for (const st of this.boards.values()) {
      const c = st.cards.get(id)
      if (!c || c.closed) continue
      this.api.updateCard(id, { closed: true }).then((u) => {
        st.cards.set(id, u)
        this.scheduleIndex(st)
        new Notice(`BoardHydra: archived “${c.name}”. Restore it from the board’s archive in BoardHydra.`)
      }).catch((e) => { if (!this.handleFatal(e)) new Notice('BoardHydra: ' + (e as Error).message) })
    }
  }
}
