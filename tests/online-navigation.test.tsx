// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/client/state/ReaderContext.tsx', () => ({
  useReader: () => ({ loadOnlineBook: vi.fn() }),
}))

import { OnlineSearchPanel } from '../src/client/components/OnlineSearchPanel.tsx'

afterEach(() => {
  document.body.replaceChildren()
})

describe('online search navigation', () => {
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
