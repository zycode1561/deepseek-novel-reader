import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAcquisition, OnlineApiError, searchOnlineBooks } from '../src/client/online/api.ts'

afterEach(() => vi.unstubAllGlobals())

describe('online client API', () => {
  it('uses same-origin routes and sends only the opaque result id', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'job' }), { status: 202 }))
    vi.stubGlobal('fetch', request)
    await createAcquisition('opaque-id')
    expect(request).toHaveBeenCalledWith('/dsh-novel-reader/online/acquisitions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ resultId: 'opaque-id' }),
    }))
  })

  it('encodes search input and preserves stable host error codes', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'RESULT_EXPIRED', message: '搜索结果已过期，请重新搜索。' },
    }), { status: 404 }))
    vi.stubGlobal('fetch', request)
    await expect(searchOnlineBooks('书 名')).rejects.toMatchObject<Partial<OnlineApiError>>({
      code: 'RESULT_EXPIRED', message: '搜索结果已过期，请重新搜索。',
    })
    expect(request.mock.calls[0]?.[0]).toBe('/dsh-novel-reader/online/search?q=%E4%B9%A6%20%E5%90%8D')
  })
})
