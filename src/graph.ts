// Graph colors: one color group per label (`tag:#bh/<label>`), in the label's own BoardHydra color.
// Pure functions only; sync.ts puts the result into Obsidian's graph settings.
import { labelTag } from './format'
import type { BHLabel } from './types'

export interface ColorGroup { query: string; color: { a: number; rgb: number } }

/** Queries the plugin owns. Groups you make yourself never start with this, so they stay put. */
export const GROUP_PREFIX = 'tag:#bh/'

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
  const mine = (Array.isArray(existing) ? existing : []).filter(isGroup).filter((g) => !g.query.startsWith(GROUP_PREFIX))
  return [...mine, ...ours]
}

export function sameGroups(a: unknown, b: ColorGroup[]): boolean {
  return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(b)
}
