import { requestUrl } from 'obsidian'
import type { BHBoard, BHCard, BHEvent, BHLabel, BHList, BHNote, BHSnapshot, CardPatch } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
  }
}

/** The `error` field of a BoardHydra error response, if there is one. */
function errorText(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') return data.error
  return undefined
}

/**
 * BoardHydra's public API. Ordinary calls use Obsidian's requestUrl: it isn't bound by CORS and sends no
 * Origin, which the server's write check expects.
 *
 * Why fetch for the event stream: requestUrl only returns once the whole response has arrived, and a live
 * stream (server-sent events) never finishes, so it can't deliver updates. fetch gives a readable body we
 * consume as it arrives. It only ever GETs one URL on the user's own BoardHydra server, and the server
 * allows read-only CORS for the Obsidian app's origins on desktop (app://obsidian.md), iOS
 * (capacitor://localhost) and Android (http://localhost).
 */
export class Api {
  remaining: number | null = null

  constructor(private base: () => string, private key: () => string, private clientId: string) {}

  private url(path: string) {
    return this.base().replace(/\/+$/, '') + '/api/v1' + path
  }

  async req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'X-Client-Id': this.clientId }
    if (auth) headers.Authorization = 'Bearer ' + this.key()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let r
    try {
      r = await requestUrl({ url: this.url(path), method, headers, body: body === undefined ? undefined : JSON.stringify(body), throw: false })
    } catch {
      throw new ApiError(0, 'Can’t reach BoardHydra — check your connection')
    }
    const rem = r.headers['x-ratelimit-remaining'] ?? r.headers['X-RateLimit-Remaining']
    if (rem !== undefined) this.remaining = Number(rem)
    let data: unknown
    try { data = r.text ? JSON.parse(r.text) : null } catch { data = null }
    if (r.status >= 400) throw new ApiError(r.status, errorText(data) ?? `BoardHydra answered ${r.status}`, data)
    return data as T
  }

  /** The board's guide for AI, as Markdown (GET /boards/{id}/guide.md). */
  async guide(id: string): Promise<string> {
    let r
    try {
      r = await requestUrl({ url: this.url(`/boards/${encodeURIComponent(id)}/guide.md`), headers: { Authorization: 'Bearer ' + this.key(), 'X-Client-Id': this.clientId }, throw: false })
    } catch {
      throw new ApiError(0, 'Can’t reach BoardHydra — check your connection')
    }
    const rem = r.headers['x-ratelimit-remaining'] ?? r.headers['X-RateLimit-Remaining']
    if (rem !== undefined) this.remaining = Number(rem)
    if (r.status >= 400) throw new ApiError(r.status, `BoardHydra answered ${r.status}`)
    return r.text
  }

  me() { return this.req<{ id: string; name: string; email: string }>('GET', '/me') }
  boards() { return this.req<BHBoard[]>('GET', '/boards') }
  snapshot(id: string) { return this.req<BHSnapshot>('GET', `/boards/${encodeURIComponent(id)}`) }
  createCard(boardId: string, p: CardPatch & { idList: string; name: string }) { return this.req<BHCard>('POST', `/boards/${encodeURIComponent(boardId)}/cards`, p) }
  updateCard(id: string, p: CardPatch) { return this.req<BHCard>('PATCH', `/cards/${encodeURIComponent(id)}`, p) }
  createList(boardId: string, name: string) { return this.req<BHList>('POST', `/boards/${encodeURIComponent(boardId)}/lists`, { name }) }
  createLabel(boardId: string, name: string, color?: string) { return this.req<BHLabel>('POST', `/boards/${encodeURIComponent(boardId)}/labels`, color ? { name, color } : { name }) }
  createNote(cardId: string, body: string) { return this.req<BHNote>('POST', `/cards/${encodeURIComponent(cardId)}/notes`, { body }) }
  updateNote(id: string, body: string) { return this.req<BHNote>('PATCH', `/notes/${encodeURIComponent(id)}`, { body }) }
  deleteNote(id: string) { return this.req<{ ok: boolean }>('DELETE', `/notes/${encodeURIComponent(id)}`) }
  revoke() { return this.req<{ ok: boolean }>('DELETE', '/obsidian/key') }
  exchange(code: string) { return this.req<{ key: string; keyId: string; vault: string; user: { name: string } }>('POST', '/obsidian/exchange', { code }, false) }

  /**
   * Opens a board's live event stream and calls onEvent for each event until the signal aborts or the
   * stream ends. Resolves when connected-then-closed; rejects with ApiError if the server refuses.
   */
  async stream(boardId: string, signal: AbortSignal, onOpen: () => void, onEvent: (e: BHEvent) => void): Promise<void> {
    const res = await fetch(this.url(`/boards/${encodeURIComponent(boardId)}/events`), {
      headers: { Authorization: 'Bearer ' + this.key(), 'X-Client-Id': this.clientId },
      signal,
    })
    if (!res.ok || !res.body) {
      let msg = `BoardHydra answered ${res.status}`
      try { msg = errorText(await res.json()) ?? msg } catch { /* not JSON */ }
      throw new ApiError(res.status, msg)
    }
    onOpen()
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
        if (!data) continue
        try { onEvent(JSON.parse(data) as BHEvent) } catch { /* skip a bad message */ }
      }
    }
  }
}
