// Graph colors: one color group per label (`tag:#bh/<label>`), in the label's own BoardHydra color.
// Pure functions only; sync.ts puts the result into Obsidian's graph settings.
import { labelTag } from './format'
import type { BHLabel } from './types'

export interface ColorGroup { query: string; color: { a: number; rgb: number } }

/** Queries the plugin owns start with one of these; groups you make yourself stay put. */
const OWN_PREFIXES = ['tag:#bh/', '[bh_']
const isOwn = (q: string) => OWN_PREFIXES.some((p) => q.startsWith(p))

const rgb = (hex: string) => ({ a: 1, rgb: parseInt(hex.slice(1), 16) })

/** Colors by note type, ahead of the labels (a node takes the first group it matches). */
export const KIND_GROUPS: ColorGroup[] = [
  { query: '[bh_kind:checkitem] [done:true]', color: rgb('#34c759') }, // finished items: green
  { query: '[bh_kind:checkitem]', color: rgb('#ff3b30') }, // open items: red
  { query: '[bh_kind:checklist]', color: rgb('#ffb347') },
  { query: '[bh_kind:list]', color: rgb('#29c4ff') },
  { query: '[bh_kind:board]', color: rgb('#7b2bff') },
  { query: '[bh_kind:archive]', color: rgb('#5a5470') },
  { query: '[bh_board] [kanban-plugin]', color: rgb('#b45cff') }, // the optional Kanban note
  { query: '[bh_note]', color: rgb('#d9c2ff') }, // notes on cards
  { query: '[bh_id] [archived:true]', color: rgb('#5a5470') },
]

/** Cards with no colored label. */
export const CARD_GROUP: ColorGroup = { query: '[bh_id]', color: rgb('#8fa8a0') }

/** Every group the plugin keeps: note types, then labels in board order, then plain cards. */
export function allColorGroups(labels: BHLabel[]): ColorGroup[] {
  return [...KIND_GROUPS, ...labelColorGroups(labels), CARD_GROUP]
}

// the free colors, for servers that don't send `hex` yet (mirror of web/src/lib/colors.ts)
const FREE_HEX: Record<string, string> = {
  green: '#4fd27a', yellow: '#f2c35b', orange: '#ff9a3a', red: '#ff5d6c', purple: '#b265ff',
  blue: '#3f9bff', sky: '#5ee0ff', lime: '#a8e05b', pink: '#ff6fb5', black: '#8a8399',
}

function rgbOf(l: BHLabel): number | null {
  const hex = l.hex || (l.color ? FREE_HEX[l.color] : '')
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  return m ? parseInt(m[1], 16) : null
}

/** Groups for these labels, in the order given (the first matching group colors a node). Labels without a color are left out. */
export function labelColorGroups(labels: BHLabel[]): ColorGroup[] {
  const out: ColorGroup[] = []
  const seen = new Set<string>()
  for (const l of labels) {
    const rgb = rgbOf(l)
    const query = 'tag:#' + labelTag(l)
    if (rgb === null || seen.has(query.toLowerCase())) continue // same label name on two boards: the first board wins
    seen.add(query.toLowerCase())
    out.push({ query, color: { a: 1, rgb } })
  }
  return out
}

function isGroup(g: unknown): g is ColorGroup {
  return !!g && typeof (g as ColorGroup).query === 'string' && typeof (g as ColorGroup).color?.rgb === 'number'
}

/** Your own groups first (they win), then ours, replacing whatever we wrote before. */
export function mergeColorGroups(existing: unknown, ours: ColorGroup[]): ColorGroup[] {
  const mine = (Array.isArray(existing) ? existing : []).filter(isGroup).filter((g) => !isOwn(g.query))
  return [...mine, ...ours]
}

/** Graph filter term that hides archived cards (every board's _archive/ folder, its index note included). */
export const ARCHIVE_FILTER = '-path:_archive'
const ARCHIVE_TERM = /(^|\s)-path:_archive(?=\s|$)/g

/** The graph's search with our archive term added (hide) or removed; whatever you typed yourself is kept as it is. */
export function withArchiveFilter(search: unknown, hide: boolean): string {
  const rest = (typeof search === 'string' ? search : '').replace(ARCHIVE_TERM, '').trim()
  if (!hide) return rest
  return rest ? `${rest} ${ARCHIVE_FILTER}` : ARCHIVE_FILTER
}

export function sameGroups(a: unknown, b: ColorGroup[]): boolean {
  return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(b)
}
