import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { NovelReaderOverlay } from './components/NovelReaderOverlay.tsx'
import { createHostLayoutBridge } from './host-layout.ts'
import { ReaderProvider } from './state/ReaderContext.tsx'
import { readerStyles } from './styles.ts'

export const name = 'dsh-novel-reader/client'
export const inject = ['slots']

/** Register additively and make every global DOM change lifecycle-reversible. */
export function apply(ctx: Context): void {
  const hostLayout = createHostLayoutBridge(document)

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-novel-reader'
    style.textContent = readerStyles
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-novel-reader: styles')

  ctx.effect(() => () => hostLayout.dispose(), 'dsh-novel-reader: host layout bridge')

  function ReaderSlot(_props: PropsRuntime<'shell.overlay'>): JSX.Element {
    return <ReaderProvider><NovelReaderOverlay onLayoutWidthChange={hostLayout.setReaderWidth} /></ReaderProvider>
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-novel-reader',
    order: 90,
  }, ReaderSlot))
}
