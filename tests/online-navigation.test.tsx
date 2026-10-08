// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OnlineBookResult } from '../src/shared/types.ts'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reader = vi.hoisted(() => ({ loadOnlineBook: vi.fn(), startOnlineReading: vi.fn() }))
const api = vi.hoisted(() => ({ searchOnlineBooks: vi.fn(), createAcquisition: vi.fn(), cancelAcquisition: vi.fn(), getAcquisition: vi.fn(), getAcquisitionResult: vi.fn() }))
vi.mock('../src/client/state/ReaderContext.tsx', () => ({ useReader: () => reader }))
vi.mock('../src/client/online/api.ts', () => api)

import { OnlineSearchPanel } from '../src/client/components/OnlineSearchPanel.tsx'

afterEach(() => {
  document.body.replaceChildren()
})

describe('online search navigation', () => {
  it('opens a search result through chapter reading without starting an acquisition', async () => {
    const result: OnlineBookResult = { id: 'result-42', sourceId: 'demo', sourceName: '演示源', sourceUrl: 'https://novels.example/books/42', bookName: '四季', author: '', intro: '', category: '', latestChapter: '', lastUpdateTime: '', status: '', wordCount: '' }
    api.searchOnlineBooks.mockResolvedValue({ results: [result], searchedSources: 1, failedSources: 0 })
    reader.startOnlineReading.mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container), onOpened = vi.fn()
    try {
      act(() => root.render(<OnlineSearchPanel onBack={vi.fn()} onOpened={onOpened} />))
      const input = container.querySelector('input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '四季')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      const button = [...container.querySelectorAll('button')].find(node => node.textContent === '在线阅读')!
      expect(button).toBeDefined()
      await act(async () => button.click())
      expect(reader.startOnlineReading).toHaveBeenCalledWith('result-42')
      expect(api.createAcquisition).not.toHaveBeenCalled()
      expect(onOpened).toHaveBeenCalledOnce()
    } finally { act(() => root.unmount()) }
  })
  it('always exposes a back action to the parent reader view', () => {
    const onBack = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    act(() => root.render(<OnlineSearchPanel onBack={onBack} onOpened={vi.fn()} />))
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    act(() => back?.click())
    expect(onBack).toHaveBeenCalledOnce()
    act(() => root.unmount())
  })
})
