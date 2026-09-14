/**
 * The web renderer plugin.
 *
 * It registers one entry into the shell's `shell.overlay` slot and draws the
 * core's projection there. `ui-layout` owns that slot, so this plugin only works
 * while that plugin is mounted — which is the arrangement the design chose for
 * the first step, before the frame tree replaces the shell outright.
 *
 * The layer occupies a bounded region and covers nothing: the shell's own chrome
 * stays visible and usable, and the pointer passes through everywhere except the
 * frames themselves.
 *
 * The build concatenates this file after the core's modules, so the relative
 * import below is erased and these names come from that shared scope. Only `react`
 * survives as a real import, answered by the shell's seeded module table.
 */
import { createElement, useEffect, useSyncExternalStore } from 'react'
import {
  REACT_CAPABILITIES, provideFramesService, project,
} from '../../../frames/src/index.ts'
import type { FramesService, FrameTypeDefinition } from '../../../frames/src/index.ts'

/** Services this plugin needs before it activates. */
export const inject = ['slots']

/** The type the shell opens with. The compatibility layer supplies its body. */
const CONVERSATION: FrameTypeDefinition = { id: 'legacy.conversation', title: () => 'Conversation' }

/** Which way a split runs. */
type SplitAxis = 'row' | 'column'

/** The projection the layer draws. */
interface Snapshot {
  readonly view: ReturnType<typeof project>
}

/** The renderer's declaration: pixels, pointer drag, real floating panels. */
const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }

/** The drawable extent, which this renderer owns and reports. */
const viewport = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

/**
 * The layer's view of the shared tree.
 *
 * It holds no layout of its own: it subscribes to `ctx.frames` and reports what
 * it measured, so the compatibility layer and any other renderer drive the same
 * tree through the same service.
 * @param service - the frame tree published by this plugin.
 * @returns the readable snapshot plus the intents this layer can send.
 */
function createController(service: FramesService) {
  let snapshot: Snapshot = { view: service.project() }
  const listeners = new Set<() => void>()

  service.subscribe(() => {
    snapshot = { view: service.project() }
    for (const listener of listeners) listener()
  })
  service.reportMeasurements({ viewport: viewport() })

  /** Send an intent; the layer draws no chrome, so a refusal lands in the console. */
  const send = (result: { ok: boolean; code?: string; message?: string }): void => {
    if (!result.ok) console.warn(`[frames] ${result.code}: ${result.message}`)
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): Snapshot => snapshot,
    remeasure(): void {
      service.reportMeasurements({ viewport: viewport() })
    },
    split(): void { send(service.split(undefined, CONVERSATION.id)) },
    close(): void { send(service.close()) },
    float(): void { send(service.float()) },
    dock(): void { send(service.dock()) },
    focus(direction: 'left' | 'right' | 'up' | 'down'): void { send(service.moveFocus(direction)) },
    focusPane(paneId: string): void { send(service.focus(paneId as never)) },
  }
}

/**
 * The layer entry: the frame tree alone, with no chrome of its own.
 * @returns the frame layer.
 */
function createOverlay(controller: ReturnType<typeof createController>) {
  return function FramesLayer({ renderSlot }: {
    renderSlot(key: 'frames.body', owner: object, options: { entryKey: string }): unknown
  }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

    useEffect(() => {
      let armed = false
      const onKey = (event: KeyboardEvent): void => {
        const target = event.target as HTMLElement | null
        if (target !== null && (target.tagName === 'INPUT' || target.isContentEditable)) return
        const key = event.key.toLowerCase()
        const prefix = armed
        armed = false

        // `C-x` arms the default key map's prefix; the chord after it may carry a
        // second modifier, so `C-x C-d` closes while `C-x d` docks.
        if (event.ctrlKey && !event.altKey && key === 'x') {
          armed = true
          event.preventDefault()
          return
        }

        const run = prefix
          ? key === 'f' ? () => controller.float()
            : key === 'd' && event.ctrlKey ? () => controller.close()
              : key === 'd' ? () => controller.dock()
                : key === 'right' ? () => controller.split()
                  : undefined
          : event.altKey
            ? key === 'h' ? () => controller.focus('left')
              : key === 'j' ? () => controller.focus('down')
                : key === 'k' ? () => controller.focus('up')
                  : key === 'l' ? () => controller.focus('right')
                    : undefined
            : undefined
        if (run === undefined) return
        event.preventDefault()
        run()
      }
      const onResize = (): void => { controller.remeasure() }
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onResize)
      }
    }, [])

    const { view } = snapshot

    const frames = view.docked.map((pane) => createElement('div', {
      key: pane.id,
      onClick: () => controller.focusPane(pane.id),
      style: {
        position: 'absolute',
        boxSizing: 'border-box',
        left: `calc(${pane.rect.x * 100}% + 1px)`,
        top: `calc(${pane.rect.y * 100}% + 1px)`,
        width: `calc(${pane.rect.width * 100}% - 2px)`,
        height: `calc(${pane.rect.height * 100}% - 2px)`,
        pointerEvents: 'auto',
        background: '#1b1f26',
        border: pane.id === view.active ? '1px solid #6ea8fe' : '1px solid #39404c',
        borderRadius: '6px',
        // A frame adds no inset of its own: the body draws its own and reaches
        // the frame's edges, so padding here would stop it filling the frame.
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
    },
    // The frame's content is whatever its type's body supplies; a type with no
    // registered body still shows its title, so an empty frame reads as one.
    createElement('div', {
      key: 'body',
      // The body must be able to fill: a flex child with no basis keeps its
      // content height, which is what left the conversation short of the frame.
      style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
    },
      pane.tabs[0] === undefined
        ? '(empty frame)'
        : renderSlot('frames.body', {}, { entryKey: pane.tabs[0].typeId }) ?? pane.tabs[0].title),
    ))

    const floats = view.floats.map((frame) => createElement('div', {
      key: frame.id,
      style: {
        position: 'absolute',
        boxSizing: 'border-box',
        ...(frame.rectHonoured
          ? {
            left: `calc(${frame.rect.x * 100}% + 1px)`,
            top: `calc(${frame.rect.y * 100}% + 1px)`,
            width: `calc(${frame.rect.width * 100}% - 2px)`,
            height: `calc(${frame.rect.height * 100}% - 2px)`,
          }
          : { right: '1px', bottom: '1px', width: '40%', height: '50%' }),
        pointerEvents: 'auto',
        background: '#202531',
        border: '1px solid #5a6272',
        borderRadius: '6px',
        padding: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,.45)',
        overflow: 'hidden',
      },
    },
    createElement('div', { key: 't', style: { fontWeight: 600 } }, frame.tabs[0]?.title ?? '(empty frame)'),
    ))

    return createElement('div', {
      style: {
        position: 'fixed',
        // This is the window now: it fills the viewport and draws every frame.
        inset: '0',
        zIndex: 40,
        pointerEvents: 'auto',
        background: '#14161a',
        color: '#d8dbe2',
        font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      },
    },
    createElement('div', { key: 'area', style: { position: 'relative', width: '100%', height: '100%' } }, frames),
    createElement('div', { key: 'floats', style: { position: 'relative', width: '100%', height: '100%' } }, floats),
    )
  }
}

/**
 * Mount the frame tree and register the layer that draws it.
 *
 * The service is mounted here rather than by a plugin of its own because this is
 * the web client's renderer: a terminal mounts the same service in its own
 * composition, which is what keeps the core out of any one host.
 * @param ctx - the client context.
 */
export function apply(ctx: {
  effect(callback: () => () => void, label: string): unknown
  reflect: { provide(name: string, value: unknown): () => void }
  slots: { inject(key: string, callback: () => unknown): () => void; register(options: unknown, component: unknown): unknown }
}): void {
  ctx.effect(() => {
    const { service, dispose } = provideFramesService(ctx, { startup: CONVERSATION, platform: PLATFORM })
    const controller = createController(service)
    const dropLayer = ctx.slots.register(
      {
        // `root` is the runtime's built-in slot, so this takes the window rather
        // than contributing to someone else's seat.
        name: 'root',
        id: 'frames-layer',
        order: 100,
        label: 'Frames',
        // Declaring the keyed body slot is what makes a frame type a content
        // family: a plugin supplies a body under that type's id.
        children: { 'frames.body': { kind: 'keyed', scope: 'root' } },
      },
      createOverlay(controller),
    )
    return () => {
      dropLayer()
      dispose()
    }
  }, 'frames-web: service + layer registration')
}
