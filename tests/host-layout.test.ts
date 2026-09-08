import { describe, expect, it } from 'vitest'
import { createHostLayoutBridge } from '../src/client/host-layout.ts'

function createHostHarness(
  initialGridTemplate = '280px minmax(0, 1fr) 0px',
  initialTransition = '',
) {
  const attributes = new Map<string, string>()
  const properties = new Map<string, string>()
  let mutationCallback: MutationCallback | undefined
  const frame = {
    style: {
      gridTemplateColumns: initialGridTemplate,
      transition: initialTransition,
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as HTMLElement
  const overlay = { parentElement: frame }
  const hostDocument = {
    querySelector: () => overlay,
    defaultView: {
      MutationObserver: class {
        constructor(callback: MutationCallback) { mutationCallback = callback }
        observe(): void {}
        disconnect(): void {}
        takeRecords(): MutationRecord[] { return [] }
      },
    },
  } as unknown as Document
  return {
    attributes, frame, hostDocument, properties,
    triggerStyleMutation: () => mutationCallback?.([], {} as MutationObserver),
  }
}

describe('host layout bridge', () => {
  it('reserves a reader grid track and restores every inline mutation', () => {
    const { attributes, frame, hostDocument } = createHostHarness(
      '280px minmax(0, 1fr) 0px', 'opacity 90ms ease',
    )
    const bridge = createHostLayoutBridge(hostDocument)

    bridge.setReaderWidth(420)
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px 420px')
    expect(frame.style.transition).toContain('grid-template-columns 180ms')
    expect(attributes.get('data-dnr-reader-layout')).toBe('open')

    bridge.dispose()
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(frame.style.transition).toBe('opacity 90ms ease')
    expect(attributes.has('data-dnr-reader-layout')).toBe(false)
  })

  it('clamps unexpected widths to the supported 280–600px range', () => {
    const { frame, hostDocument } = createHostHarness()
    const bridge = createHostLayoutBridge(hostDocument)

    bridge.setReaderWidth(900)
    expect(frame.style.gridTemplateColumns).toMatch(/ 600px$/)
    bridge.setReaderWidth(100)
    expect(frame.style.gridTemplateColumns).toMatch(/ 280px$/)
  })

  it('keeps a zero-width track while closed so opening can animate without changing the grid shape', () => {
    const { attributes, frame, hostDocument } = createHostHarness()
    const bridge = createHostLayoutBridge(hostDocument)

    bridge.setReaderWidth(null)
    expect(frame.style.gridTemplateColumns).toMatch(/ 0px$/)
    expect(attributes.get('data-dnr-reader-layout')).toBe('closed')
  })

  it('reapplies the reader track after the host updates its three-column template', () => {
    const { frame, hostDocument, triggerStyleMutation } = createHostHarness()
    const bridge = createHostLayoutBridge(hostDocument)

    bridge.setReaderWidth(360)
    frame.style.gridTemplateColumns = '64px minmax(0, 1fr) 240px'
    triggerStyleMutation()
    expect(frame.style.gridTemplateColumns).toBe('64px minmax(0, 1fr) 240px 360px')
  })
})
