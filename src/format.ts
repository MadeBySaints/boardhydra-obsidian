// Card ⇄ note. Pure functions (no Obsidian imports), so they run in tests too.
//
// A card note:
//   ---
//   bh_id: <card id>            (never edit)
//   bh_board: <board id>
//   bh_updated: <dateLastActivity when last synced>
//   name: <exact card name>     (only when the file name can't hold it)
//   list: "[[BoardHydra/My board/Lists/To do|To do]]"   (links the card to its list note)
//   tags: [bh/Bug, idea]       (bh/... tags are the card's labels; other tags are yours and stay put)
//   members: ["[[Sam Lee]]"]
//   start: 2026-11-20T15:00:00Z
//   due: 2026-11-21T17:00:00Z
//   done: false
//   ---
//   <description>
//
//   ## Checklist: <name>
//   - [ ] item
//     - [x] sub-item
//
//   ## Links
//   - [title](https://…)

import type { BHCard, BHCheckItem, BHChecklist, BHLabel, BHLink, BHList, BHMember, CardPatch } from './types'

export interface Yaml {
  parse(s: string): any
  stringify(o: any): string
}

export interface BoardCtx {
  lists: BHList[]
  labels: BHLabel[]
  members: BHMember[]
  /** wiki link for a list's note; without it the list is written by name */
  listLink?: (l: BHList) => string
}

/** Tag prefix for labels. Tags without it belong to the user. */
export const TAG_PREFIX = 'bh/'

/** Frontmatter keys the plugin writes; everything else in a note's frontmatter is the user's and is kept. */
const OWN_KEYS = new Set(['bh_id', 'bh_board', 'bh_updated', 'name', 'list', 'labels', 'tags', 'members', 'start', 'due', 'done'])

const CHECKLIST = '## Checklist: '
const LINKS = '## Links'

/** A file name that works on every OS and in wiki links. */
export function safeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim()
  return s || 'Untitled'
}

export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: null, body: text }
  return { fm: m[1], body: text.slice(m[0].length) }
}

function labelName(l: BHLabel): string {
  return l.name || l.color || 'label'
}

/** A label as an Obsidian tag: no spaces, only letters, digits, _ and -. */
export function labelTag(l: BHLabel): string {
  const t = labelName(l).trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return TAG_PREFIX + (t || 'label')
}

/** "[[path|alias]]" -> alias (or the path's last part); plain text stays as it is. */
export function unlink(v: string): string {
  const m = /^\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*$/.exec(v)
  if (!m) return v.trim()
  return (m[2] ?? m[1].split('/').pop() ?? m[1]).trim()
}

export function wikiLink(target: string, label: string): string {
  const clean = label.replace(/[[\]|]/g, '')
  return target === clean ? `[[${target}]]` : `[[${target}|${clean}]]`
}

function memberName(m: BHMember): string {
  return m.fullName || m.username
}

function renderItems(items: BHCheckItem[], indent: string): string[] {
  const out: string[] = []
  for (const it of [...items].sort((a, b) => a.pos - b.pos)) {
    out.push(`${indent}- [${it.state === 'complete' ? 'x' : ' '}] ${it.name}`)
    if (it.children?.length) out.push(...renderItems(it.children, indent + '  '))
  }
  return out
}

/**
 * existing: the note's current frontmatter, if any. Keys the plugin doesn't own are kept, and so are the
 * user's own tags (any tag without the bh/ prefix).
 */
export function renderCard(c: BHCard, ctx: BoardCtx, yaml: Yaml, existing: Record<string, any> = {}): string {
  const fm: Record<string, unknown> = { bh_id: c.id, bh_board: c.idBoard, bh_updated: c.dateLastActivity }
  if (safeName(c.name) !== c.name) fm.name = c.name
  const list = ctx.lists.find((l) => l.id === c.idList)
  fm.list = list ? (ctx.listLink ? ctx.listLink(list) : list.name) : ''
  const own = asList(existing.tags).filter((t) => !t.replace(/^#/, '').startsWith(TAG_PREFIX))
  fm.tags = [...c.idLabels.map((id) => ctx.labels.find((l) => l.id === id)).filter((l): l is BHLabel => !!l).map(labelTag), ...own]
  fm.members = c.idMembers.map((id) => ctx.members.find((m) => m.id === id)).filter((m): m is BHMember => !!m)
    .map((m) => wikiLink(safeName(memberName(m)), memberName(m)))
  fm.start = c.start ?? ''
  fm.due = c.due ?? ''
  fm.done = c.dueComplete
  for (const [k, v] of Object.entries(existing)) if (!OWN_KEYS.has(k)) fm[k] = v
  const parts: string[] = [`---\n${yaml.stringify(fm).trimEnd()}\n---\n`]
  const desc = (c.desc ?? '').trim()
  if (desc) parts.push(desc + '\n')
  for (const cl of c.checklists ?? []) {
    parts.push(`\n${CHECKLIST}${cl.name}\n${renderItems(cl.checkItems ?? [], '').join('\n')}\n`)
  }
  if (c.links?.length) {
    parts.push(`\n${LINKS}\n${c.links.map((l) => `- [${(l.title || l.url).replace(/[[\]]/g, '')}](${l.url})`).join('\n')}\n`)
  }
  return parts.join('')
}

export interface ParsedItem { name: string; done: boolean; children: ParsedItem[] }
export interface ParsedNote {
  fm: Record<string, any>
  desc: string
  checklists: { name: string; items: ParsedItem[] }[]
  links: { url: string; title: string }[]
}

export function parseNote(text: string, yaml: Yaml): ParsedNote {
  const { fm, body } = splitFrontmatter(text)
  let meta: Record<string, any> = {}
  if (fm !== null) {
    try {
      const v = yaml.parse(fm)
      if (v && typeof v === 'object') meta = v
    } catch {
      meta = {}
    }
  }
  const out: ParsedNote = { fm: meta, desc: '', checklists: [], links: [] }
  const desc: string[] = []
  let section: 'desc' | 'checklist' | 'links' = 'desc'
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(CHECKLIST)) {
      section = 'checklist'
      out.checklists.push({ name: line.slice(CHECKLIST.length).trim(), items: [] })
      continue
    }
    if (line.trim() === LINKS) {
      section = 'links'
      continue
    }
    if (section === 'desc') {
      desc.push(line)
    } else if (section === 'checklist') {
      const m = /^(\s*)[-*] \[([ xX])\] (.*)$/.exec(line)
      if (!m) continue
      const item: ParsedItem = { name: m[3].trim(), done: m[2] !== ' ', children: [] }
      const items = out.checklists[out.checklists.length - 1].items
      if (m[1].length >= 2 && items.length) items[items.length - 1].children.push(item) // one level of sub-items
      else items.push(item)
    } else {
      const m = /^\s*[-*] \[([^\]]*)\]\((\S+?)\)\s*$/.exec(line) ?? /^\s*[-*] (https?:\/\/\S+)\s*$/.exec(line)
      if (!m) continue
      if (m.length === 3) out.links.push({ title: m[1].trim(), url: m[2] })
      else out.links.push({ title: '', url: m[1] })
    }
  }
  out.desc = desc.join('\n').trim()
  return out
}

/** The card's name as the note gives it: the file name, unless `name:` still matches it. */
export function noteName(parsed: ParsedNote, basename: string): string {
  const n = typeof parsed.fm.name === 'string' ? parsed.fm.name : ''
  return n && safeName(n) === basename ? n : basename
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean)
  return []
}

function asDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** Same moment, whatever the spelling (YAML may turn dates into Date objects, which print with milliseconds). */
function sameDate(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const x = Date.parse(a), y = Date.parse(b)
  return !Number.isNaN(x) && x === y
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const lc = (s: string) => s.toLowerCase()

export type GenId = () => string

function toItems(parsed: ParsedItem[], old: BHCheckItem[], genId: GenId): BHCheckItem[] {
  const sorted = [...old].sort((a, b) => a.pos - b.pos)
  const used = new Set<string>()
  // reuse ids: same name first, then same position
  const pick = (name: string, i: number): BHCheckItem | undefined => {
    const byName = sorted.find((o) => !used.has(o.id) && o.name === name)
    const byPos = sorted[i] && !used.has(sorted[i].id) ? sorted[i] : undefined
    const o = byName ?? byPos
    if (o) used.add(o.id)
    return o
  }
  return parsed.map((p, i) => {
    const o = pick(p.name, i)
    const item: BHCheckItem = { id: o?.id ?? genId(), name: p.name, state: p.done ? 'complete' : 'incomplete', pos: (i + 1) * 65536 }
    if (p.children.length) item.children = toItems(p.children, o?.children ?? [], genId)
    return item
  })
}

function toChecklists(parsed: ParsedNote['checklists'], card: BHCard | null, genId: GenId): BHChecklist[] {
  const old = card?.checklists ?? []
  const used = new Set<string>()
  return parsed.map((p, i) => {
    const o = old.find((c) => !used.has(c.id) && c.name === p.name) ?? (old[i] && !used.has(old[i].id) ? old[i] : undefined)
    if (o) used.add(o.id)
    const id = o?.id ?? genId()
    return { id, idCard: card?.id ?? '', name: p.name, checkItems: toItems(p.items, o?.checkItems ?? [], genId) }
  })
}

/** Canonical form of a card's checklists, for comparing (ids and positions as the server keeps them). */
function normChecklists(cls: BHChecklist[] | null): unknown {
  return (cls ?? []).map((c) => ({
    id: c.id, name: c.name,
    items: [...(c.checkItems ?? [])].sort((a, b) => a.pos - b.pos).map((it) => ({
      id: it.id, name: it.name, state: it.state,
      children: [...(it.children ?? [])].sort((a, b) => a.pos - b.pos).map((ch) => ({ id: ch.id, name: ch.name, state: ch.state })),
    })),
  }))
}

export interface PatchResult { patch: CardPatch; warnings: string[] }

/**
 * What to send so the server card matches the note. With card = null (a new note) every field is set.
 * Unknown lists, labels and members are left out with a warning.
 */
export function noteToPatch(parsed: ParsedNote, basename: string, card: BHCard | null, ctx: BoardCtx, genId: GenId): PatchResult {
  const p: CardPatch = {}
  const warnings: string[] = []
  const fm = parsed.fm

  const name = noteName(parsed, basename)
  if (!card || name !== card.name) p.name = name
  if (!card || parsed.desc !== (card.desc ?? '').trim()) p.desc = parsed.desc

  // a link written without quotes is read by YAML as a nested list: [["path|alias"]]
  const rawList = Array.isArray(fm.list) ? `[[${String(fm.list.flat(2)[0] ?? '')}]]` : fm.list
  const listName = typeof rawList === 'string' ? unlink(rawList) : ''
  if (listName) {
    const open = ctx.lists.filter((l) => !l.closed)
    const l = open.find((x) => x.name === listName) ?? open.find((x) => lc(x.name) === lc(listName))
    if (!l) warnings.push(`No list named “${fm.list}” on this board`)
    else if (!card || l.id !== card.idList) p.idList = l.id
  }

  if ('labels' in fm || 'tags' in fm) {
    const ids: string[] = []
    // labels are the bh/ tags; an old-style `labels:` list (0.1.0 notes) still counts
    const tagged = asList(fm.tags).map((t) => t.replace(/^#/, '')).filter((t) => t.startsWith(TAG_PREFIX))
    for (const t of tagged) {
      const l = ctx.labels.find((x) => labelTag(x) === t) ?? ctx.labels.find((x) => lc(labelTag(x)) === lc(t))
      if (l) { if (!ids.includes(l.id)) ids.push(l.id) } else warnings.push(`No label for #${t} on this board`)
    }
    for (const n of asList(fm.labels)) {
      const l = ctx.labels.find((x) => labelName(x) === n) ?? ctx.labels.find((x) => lc(labelName(x)) === lc(n))
      if (l) { if (!ids.includes(l.id)) ids.push(l.id) } else warnings.push(`No label named “${n}” on this board`)
    }
    if (!card || !eq([...ids].sort(), [...card.idLabels].sort())) p.idLabels = ids
  }

  if ('members' in fm) {
    const ids: string[] = []
    for (const n of asList(fm.members).map(unlink)) {
      const m = ctx.members.find((x) => memberName(x) === n || x.username === n) ?? ctx.members.find((x) => lc(memberName(x)) === lc(n) || lc(x.username) === lc(n))
      if (m) ids.push(m.id)
      else warnings.push(`No board member named “${n}”`)
    }
    if (!card || !eq([...ids].sort(), [...card.idMembers].sort())) p.idMembers = ids
  }

  if ('start' in fm) {
    const v = asDate(fm.start)
    if (!card ? v !== null : !sameDate(v, card.start ?? null)) p.start = v
  }
  if ('due' in fm) {
    const v = asDate(fm.due)
    if (!card ? v !== null : !sameDate(v, card.due ?? null)) p.due = v
  }
  if ('done' in fm) {
    const v = fm.done === true || fm.done === 'true'
    if (!card || v !== card.dueComplete) p.dueComplete = v
  }

  const cls = toChecklists(parsed.checklists, card, genId)
  if (!card ? cls.length > 0 : !eq(normChecklists(cls), normChecklists(card.checklists))) p.checklists = cls

  const oldLinks = card?.links ?? []
  const links: BHLink[] = parsed.links.map((l) => {
    const o = oldLinks.find((x) => x.url === l.url)
    const title = l.title && l.title !== l.url ? l.title : ''
    return o?.id ? { id: o.id, url: l.url, title } : { url: l.url, title }
  })
  const norm = (ls: BHLink[]) => ls.map((l) => ({ url: l.url, title: l.title && l.title !== l.url ? l.title : '' }))
  if (!card ? links.length > 0 : !eq(norm(links), norm(oldLinks))) p.links = links

  return { patch: p, warnings }
}

// ---------- graph notes: board -> lists -> cards ----------

/** The board's note: links to each of its list notes. */
export function renderBoardNote(boardId: string, name: string, desc: string, lists: { link: string }[]): string {
  const out = ['---', `bh_board: ${boardId}`, 'bh_kind: board', '---', `# ${name}`, '']
  if (desc.trim()) out.push(desc.trim(), '')
  out.push('## Lists', ...lists.map((l) => `- ${l.link}`), '', '_Kept up to date by the BoardHydra plugin. Edits here are replaced._', '')
  return out.join('\n')
}

/** A list's note: links up to its board and down to its cards, in order. */
export function renderListNote(boardId: string, list: BHList, boardLink: string, cards: { link: string; done: boolean }[]): string {
  const out = ['---', `bh_board: ${boardId}`, `bh_list: ${list.id}`, 'bh_kind: list', '---', `# ${list.name}`, '', `Board: ${boardLink}`, '', '## Cards']
  out.push(...cards.map((c) => `- [${c.done ? 'x' : ' '}] ${c.link}`), '', '_Kept up to date by the BoardHydra plugin. Edits here are replaced._', '')
  return out.join('\n')
}

// ---------- board index note (Obsidian Kanban plugin format) ----------

export function renderIndex(boardId: string, lists: BHList[], cards: BHCard[], pathOf: (c: BHCard) => string): string {
  const out = ['---', '', 'kanban-plugin: board', `bh_board: ${boardId}`, '', '---', '']
  for (const l of [...lists].filter((x) => !x.closed).sort((a, b) => a.pos - b.pos)) {
    out.push(`## ${l.name}`, '')
    for (const c of cards.filter((x) => x.idList === l.id && !x.closed).sort((a, b) => a.pos - b.pos)) {
      out.push(`- [${c.dueComplete ? 'x' : ' '}] [[${pathOf(c)}|${c.name.replace(/[[\]|]/g, '')}]]`)
    }
    out.push('', '')
  }
  out.push('%% kanban:settings', '```', '{"kanban-plugin":"board","list-collapse":[]}', '```', '%%', '')
  return out.join('\n')
}

/** Lists in the index note, in order, each with the link targets of its cards (in order). */
export function parseIndex(text: string): { list: string; targets: string[] }[] {
  const { body } = splitFrontmatter(text)
  const out: { list: string; targets: string[] }[] = []
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('%% kanban:settings')) break
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      out.push({ list: h[1], targets: [] })
      continue
    }
    const m = /^\s*[-*] \[[ xX]\] .*?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(line)
    if (m && out.length) out[out.length - 1].targets.push(m[1].trim())
  }
  return out
}

/** A position between two neighbours (gaps of 65536, as the server uses). */
export function posBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 65536
  if (before === undefined) return after! / 2
  if (after === undefined) return before + 65536
  return (before + after) / 2
}
