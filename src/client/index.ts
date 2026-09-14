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
  REACT_CAPABILITIES, closeFrame, createFrameState, dockFrame, floatFrame, focusFrame, moveFocus,
  project, splitFrame, withMeasurements,
} from '../../../frames/src/index.ts'
import type { FrameState, FrameTypeDefinition } from '../../../frames/src/index.ts'

/** Services this plugin needs before it activates. */
export const inject = ['slots']

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

/** Which way a split runs. */
type SplitAxis = 'row' | 'column'

/** The core state plus what the layer needs to draw it. */
interface Snapshot {
  readonly view: ReturnType<typeof project>
}

/**
 * One layer's state. Kept outside React so a resize or a key press can publish
 * without a component owning the layout.
 */
function createController() {
  const platform = { id: 'react', capabilities: REACT_CAPABILITIES }
  const measured = (): FrameState => withMeasurements(
    state,
    { viewport: { width: window.innerWidth, height: window.innerHeight } },
  )
  let state: FrameState = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform }),
    { viewport: { width: window.innerWidth, height: window.innerHeight } },
  )
  let snapshot: Snapshot = { view: project(state) }

  const listeners = new Set<() => void>()
  const publish = (): void => {
    snapshot = { view: project(state) }
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): Snapshot => snapshot,
    /** Adopt an accepted intent; a refusal changes nothing and is reported. */
    run(result: ReturnType<typeof splitFrame>): void {
      if (!result.ok) {
        // The layer draws no chrome, so the console is where a refusal lands.
        console.warn(`[frames] ${result.code}: ${result.message}`)
        return
      }
      state = result.value
      publish()
    },
    remeasure(): void {
      state = measured()
      publish()
    },
    split(): void { this.run(splitFrame(state, undefined, CONVERSATION.id)) },
    close(): void { this.run(closeFrame(state)) },
    float(): void { this.run(floatFrame(state)) },
    dock(): void { this.run(dockFrame(state)) },
    focus(direction: 'left' | 'right' | 'up' | 'down'): void { this.run(moveFocus(state, direction)) },
    focusPane(paneId: string): void { this.run(focusFrame(state, paneId as never)) },
  }
}

/**
 * The layer entry: the frame tree alone, with no chrome of its own.
 * @returns the frame layer.
 */
function createOverlay(controller: ReturnType<typeof createController>) {
  return function FramesLayer() {
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
        // Only the frames take the pointer; everything between them passes through.
        pointerEvents: 'auto',
        background: '#1b1f26',
        border: pane.id === view.active ? '1px solid #6ea8fe' : '1px solid #39404c',
        borderRadius: '6px',
        padding: '8px',
        overflow: 'hidden',
      },
    },
    createElement('div', { key: 't', style: { fontWeight: 600 } }, pane.tabs[0]?.title ?? '(empty frame)'),
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
        // A bounded region over the shell's centre column. It covers nothing the
        // user needs: the sidebar and header stay visible and usable.
        top: '56px',
        left: '272px',
        right: '12px',
        bottom: '12px',
        zIndex: 40,
        pointerEvents: 'none',
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
 * Register the layer entry.
 * @param ctx - the client context.
 */
export function apply(ctx: { slots: { inject(key: string, callback: () => unknown): unknown; register(options: unknown, component: unknown): unknown } }): void {
  const controller = createController()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'frames-layer', order: 100, label: 'Frames' },
    createOverlay(controller),
  ))
}
