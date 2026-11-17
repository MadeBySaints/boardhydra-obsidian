import { requestUrl } from 'obsidian'
import type { BHBoard, BHCard, BHEvent, BHNote, BHSnapshot, CardPatch } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message)
  }
}

/**
 * BoardHydra's public API. Ordinary calls use Obsidian's requestUrl: it isn't bound by CORS and sends no
 * Origin, which the server's write check expects. The event stream needs a streamed body, so it uses fetch;
 * the server allows read-only CORS for the Obsidian app's origins.
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
    } catch (e) {
      throw new ApiError(0, 'Can’t reach BoardHydra — check your connection')
    }
    const rem = r.headers['x-ratelimit-remaining'] ?? r.headers['X-RateLimit-Remaining']
    if (rem !== undefined) this.remaining = Number(rem)
    let data: any = null
    try { data = r.text ? JSON.parse(r.text) : null } catch { data = null }
    if (r.status >= 400) throw new ApiError(r.status, data?.error ?? `BoardHydra answered ${r.status}`, data)
    return data as T
  }

  me() { return this.req<{ id: string; name: string; email: string }>('GET', '/me') }
  boards() { return this.req<BHBoard[]>('GET', '/boards') }
  snapshot(id: string) { return this.req<BHSnapshot>('GET', `/boards/${encodeURIComponent(id)}`) }
  createCard(boardId: string, p: CardPatch & { idList: string; name: string }) { return this.req<BHCard>('POST', `/boards/${encodeURIComponent(boardId)}/cards`, p) }
  updateCard(id: string, p: CardPatch) { return this.req<BHCard>('PATCH', `/cards/${encodeURIComponent(id)}`, p) }
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
      try { msg = (await res.json()).error ?? msg } catch { /* not JSON */ }
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
        try { onEvent(JSON.parse(data)) } catch { /* skip a bad message */ }
      }
    }
  }
}
