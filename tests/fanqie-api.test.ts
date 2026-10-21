import { afterEach, expect, it, vi } from 'vitest'
import { getFanqieShelf, openFanqieBook } from '../src/client/fanqie/api.ts'

afterEach(() => vi.unstubAllGlobals())

it('marks both bodyless and JSON requests and confines them to the current origin', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('[]'))
  vi.stubGlobal('fetch', fetch)
  await getFanqieShelf()
  await openFanqieBook('12', '春')
  expect(fetch).toHaveBeenNthCalledWith(1, '/dsh-novel-reader/fanqie/shelf', expect.objectContaining({
    method: 'POST', mode: 'same-origin', credentials: 'same-origin', headers: { 'x-novel-reader-request': '1' },
  }))
  expect(fetch).toHaveBeenNthCalledWith(2, '/dsh-novel-reader/fanqie/books/open', expect.objectContaining({
    mode: 'same-origin', headers: { 'x-novel-reader-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: '12', name: '春', fromPhone: false }),
  }))
})
