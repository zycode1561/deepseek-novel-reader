// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reader = vi.hoisted(() => ({
  loadFile: vi.fn(),
  loading: false,
  recents: [{
    id: 'recent-1',
    name: '很长的测试小说名称.txt',
    size: 2048,
    encoding: 'utf-8' as const,
    openedAt: 1,
    format: 'txt' as const,
    progressPercent: 42 as number | undefined,
  }],
  openRecent: vi.fn(),
  removeRecent: vi.fn(),
  error: null as string | null,
  clearError: vi.fn(),
}))

vi.mock('../src/client/state/ReaderContext.tsx', () => ({
  useReader: () => reader,
}))

import { FileLoader } from '../src/client/components/FileLoader.tsx'

let root: Root | null = null

function renderLoader(onOpened: () => void): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(<FileLoader compact onOpened={onOpened} onBrowseOnline={vi.fn()} />))
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  reader.error = null
  reader.recents[0]!.progressPercent = 42
  reader.loadFile.mockResolvedValue(false)
  reader.openRecent.mockResolvedValue(false)
})

afterEach(() => {
  if (root !== null) act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

describe('file loader navigation', () => {
  it('shows a labelled progress bar for a recent book', () => {
    const container = renderLoader(vi.fn())

    const progress = container.querySelector<HTMLElement>('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuemin')).toBe('0')
    expect(progress?.getAttribute('aria-valuemax')).toBe('100')
    expect(progress?.getAttribute('aria-valuenow')).toBe('42')
    expect(progress?.querySelector<HTMLElement>('i')?.style.width).toBe('42%')
    expect(container.textContent).toContain('已读 42%')
  })

  it('marks legacy recent books as waiting for a progress update', () => {
    reader.recents[0]!.progressPercent = undefined
    const container = renderLoader(vi.fn())

    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.textContent).toContain('进度待更新')
  })

  it('enters the reader after a recent book opens successfully', async () => {
    const onOpened = vi.fn()
    reader.openRecent.mockResolvedValue(true)
    const container = renderLoader(onOpened)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.dnr-recent-main')?.click()
      await Promise.resolve()
    })

    expect(reader.openRecent).toHaveBeenCalledWith('recent-1')
    expect(onOpened).toHaveBeenCalledOnce()
  })

  it('stays on the file view when a recent book cannot be opened', async () => {
    const onOpened = vi.fn()
    reader.error = '未找到缓存正文，请重新选择原文件。'
    const container = renderLoader(onOpened)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.dnr-recent-main')?.click()
      await Promise.resolve()
    })

    expect(onOpened).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('未找到缓存正文')
  })

  it('enters the reader after a local file loads successfully', async () => {
    const onOpened = vi.fn()
    reader.loadFile.mockResolvedValue(true)
    const container = renderLoader(onOpened)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    const file = new File(['Chapter 1\nHello'], 'story.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    expect(reader.loadFile).toHaveBeenCalledWith(file)
    expect(onOpened).toHaveBeenCalledOnce()
  })

  it('stays on the file view when a local file fails to load', async () => {
    const onOpened = vi.fn()
    reader.error = '文件读取失败。'
    const container = renderLoader(onOpened)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    const file = new File(['broken'], 'story.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onOpened).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件读取失败')
  })
})
