import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefCallback } from 'react'
import { Icon } from './Icon.tsx'

interface ReaderHeaderProps {
  fanqie: boolean
  onSourceChange: (fanqie: boolean) => void
  fanqieToolbarRef: RefCallback<HTMLDivElement>
  children: ReactNode
}

/** Both libraries share one overlay, so revealing navigation never reflows the book. */
export function ReaderHeader({ fanqie, onSourceChange, fanqieToolbarRef, children }: ReaderHeaderProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const header = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const keyboardMode = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controlsId = useId()

  useLayoutEffect(() => {
    const shell = header.current?.closest<HTMLElement>('.dnr-shell')
    const conversationHeader = document.querySelector<HTMLElement>('[data-conversation-header]')
    if (!shell || !conversationHeader) return
    const property = '--dnr-header-height'
    const previous = shell.style.getPropertyValue(property)
    const alignHeader = (): void => {
      const height = conversationHeader.getBoundingClientRect().bottom - shell.getBoundingClientRect().top - shell.clientTop
      if (height > 0) shell.style.setProperty(property, `${height}px`)
    }
    alignHeader()
    const observer = new ResizeObserver(alignHeader)
    observer.observe(conversationHeader)
    window.addEventListener('resize', alignHeader)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', alignHeader)
      if (previous) shell.style.setProperty(property, previous)
      else shell.style.removeProperty(property)
    }
  }, [])

  const clearHideTimer = (): void => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = null
  }
  const keyboardInside = (): boolean => keyboardMode.current && header.current?.contains(document.activeElement) === true
  const reveal = (): void => { clearHideTimer(); setOpen(true) }
  const scheduleHide = (): void => {
    clearHideTimer()
    if (pointerInside.current) return
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      if (!pointerInside.current && !keyboardInside()) setOpen(false)
    }, 300)
  }

  useLayoutEffect(() => { controls.current?.toggleAttribute('inert', !open) }, [open])
  useEffect(() => {
    const region = header.current!
    // DOM containment matters here: Fanqie tools are portalled from another
    // React subtree, whose synthetic enter/leave and focus paths differ.
    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || (event.relatedTarget instanceof Node && region.contains(event.relatedTarget))) return
      pointerInside.current = true
      reveal()
    }
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget instanceof Node && region.contains(event.relatedTarget)) return
      pointerInside.current = false
      scheduleHide()
    }
    const onPointerCancel = (): void => { pointerInside.current = false; scheduleHide() }
    const onFocusIn = (): void => reveal()
    const onFocusOut = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !region.contains(event.relatedTarget)) scheduleHide()
    }
    const onKeyDown = (): void => { keyboardMode.current = true }
    const onPointerDown = (event: PointerEvent): void => {
      keyboardMode.current = false
      if (event.target instanceof Node && !header.current?.contains(event.target)) {
        pointerInside.current = false
        clearHideTimer()
        setOpen(false)
      }
    }
    const onWindowBlur = (): void => {
      pointerInside.current = false
      keyboardMode.current = false
      clearHideTimer()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    region.addEventListener('pointerover', onPointerOver)
    region.addEventListener('pointerout', onPointerOut)
    region.addEventListener('pointercancel', onPointerCancel)
    region.addEventListener('focusin', onFocusIn)
    region.addEventListener('focusout', onFocusOut)
    return () => {
      clearHideTimer()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      region.removeEventListener('pointerover', onPointerOver)
      region.removeEventListener('pointerout', onPointerOut)
      region.removeEventListener('pointercancel', onPointerCancel)
      region.removeEventListener('focusin', onFocusIn)
      region.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  return <div ref={header} className={`dnr-header ${open ? 'is-open' : ''}`}>
    <button className="dnr-header-reveal" type="button" aria-label="展开顶部阅读工具" aria-expanded={open} aria-controls={controlsId} onClick={reveal}>
      <span aria-hidden="true" />
    </button>
    <div ref={controls} id={controlsId} className="dnr-header-content" aria-hidden={!open}>
      <div className="dnr-library-switch" role="tablist" aria-label="书库来源">
        <button type="button" role="tab" aria-selected={!fanqie} onClick={() => onSourceChange(false)}><Icon name="library" /><span>本地书库</span></button>
        <button type="button" role="tab" aria-selected={fanqie} onClick={() => onSourceChange(true)}><Icon name="book" /><span>番茄小说</span></button>
      </div>
      {!fanqie && children}
      <div ref={fanqieToolbarRef} hidden={!fanqie} />
    </div>
  </div>
}
