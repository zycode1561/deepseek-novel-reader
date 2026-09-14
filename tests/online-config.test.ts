import { describe, expect, it } from 'vitest'
import { resolveOnlineConfig } from '../src/index.ts'

describe('online engine configuration', () => {
  it('provides the documented defaults', () => {
    expect(resolveOnlineConfig({})).toEqual({
      searchConcurrency: 6,
      chapterConcurrency: 20,
      requestTimeoutMs: 15_000,
      searchTimeoutMs: 60_000,
      maxRetries: 3,
      minRequestIntervalMs: 200,
      maxRequestIntervalMs: 400,
      maxSearchResults: 100,
    })
  })

  it('rejects unsafe or internally inconsistent values', () => {
    expect(() => resolveOnlineConfig({ searchConcurrency: 0 })).toThrow('searchConcurrency')
    expect(() => resolveOnlineConfig({ minRequestIntervalMs: 500, maxRequestIntervalMs: 100 })).toThrow('maxRequestIntervalMs')
    expect(() => resolveOnlineConfig({ proxyUrl: 'file:///tmp/proxy' })).toThrow('http or https')
    expect(() => resolveOnlineConfig({ proxyUrl: 'not a url' })).toThrow('absolute URL')
  })
})
