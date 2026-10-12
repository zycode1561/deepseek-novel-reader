// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderHeader } from '../src/client/components/ReaderHeader.tsx'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const changeSource = vi.fn()
const toolbarRef = vi.fn()
const header = (): HTMLElement => container.querySelector('.dnr-header')!
const reveal = (): HTMLButtonElement => container.querySelector('.dnr-header-reveal')!
const controls = (): HTMLElement => container.querySelector('.dnr-header-content')!
function pointer(type: 'pointerover' | 'pointerout', pointerType = 'mouse'): void {
  act(() => header().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: document.body })))
}
function advance(ms: number): void { act(() => vi.advanceTimersByTime(ms)) }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  act(() => root.render(<ReaderHeader fanqie onSourceChange={changeSource} fanqieToolbarRef={toolbarRef}>
    <button type="button">本地工具</button>
  </ReaderHeader>))
})
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers() })

describe('reader header reveal', () => {
  it('hides the complete control region and reveals both library tabs together', () => {
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
    expect(controls().hasAttribute('inert')).toBe(true)
    pointer('pointerover')
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    expect(controls().hasAttribute('inert')).toBe(false)
    expect(controls().querySelectorAll('[role="tab"]')).toHaveLength(2)
    act(() => controls().querySelector<HTMLButtonElement>('[aria-selected="false"]')!.click())
    expect(changeSource).toHaveBeenCalledWith(false)
  })

  it('delays hiding for 300ms and cancels that hide when the pointer returns', () => {
    pointer('pointerover'); pointer('pointerout'); advance(299)
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    pointer('pointerover'); advance(500)
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    pointer('pointerout'); advance(300)
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
    expect(controls().hasAttribute('inert')).toBe(true)
  })

  it('keeps keyboard navigation visible until focus leaves the header', () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      reveal().focus()
      controls().querySelector<HTMLButtonElement>('[role="tab"]')!.focus()
    })
    pointer('pointerout'); advance(500)
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    const outside = document.createElement('button'); document.body.append(outside)
    act(() => outside.focus()); advance(300)
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
  })

  it('treats the portalled Fanqie toolbar as part of the same pointer and focus region', () => {
    function WithFanqieToolbar(): JSX.Element {
      const [target, setTarget] = useState<HTMLDivElement | null>(null)
      return <>
        <ReaderHeader fanqie onSourceChange={changeSource} fanqieToolbarRef={setTarget}>{null}</ReaderHeader>
        {target && createPortal(<button data-testid="fanqie-tool">番茄工具</button>, target)}
      </>
    }
    act(() => root.render(<WithFanqieToolbar />))
    pointer('pointerover')
    const source = controls().querySelector<HTMLButtonElement>('[role="tab"]')!
    const tool = controls().querySelector<HTMLButtonElement>('[data-testid="fanqie-tool"]')!
    act(() => {
      source.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: tool }))
      tool.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: source }))
    })
    advance(500)
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      tool.focus()
    })
    pointer('pointerout'); advance(500)
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    const outside = document.createElement('button'); document.body.append(outside)
    act(() => outside.focus()); advance(300)
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
  })

  it('allows touch users to open the tools and dismiss them without consuming the outside action', () => {
    pointer('pointerover', 'touch')
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
    act(() => reveal().click())
    expect(reveal().getAttribute('aria-expanded')).toBe('true')
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' })
    act(() => document.body.dispatchEvent(event))
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not pin a mouse-clicked control open after leaving it', () => {
    pointer('pointerover')
    const tab = controls().querySelector<HTMLButtonElement>('[role="tab"]')!
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      tab.focus()
      tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    })
    pointer('pointerout'); advance(300)
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the window loses focus and clears pending hides', () => {
    pointer('pointerover'); pointer('pointerout')
    act(() => window.dispatchEvent(new Event('blur')))
    expect(reveal().getAttribute('aria-expanded')).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
  })
})
