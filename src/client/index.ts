/**
 * The web renderer plugin.
 *
 * It registers one entry into the shell's `shell.overlay` slot and draws the
 * core's projection there. `ui-layout` owns that slot, so this plugin only works
 * while that plugin is mounted — which is exactly the arrangement the design
 * chose for the first step: the new shell is drawn over the existing one.
 *
 * The build concatenates this file after the core's modules, so the relative
 * import below is erased and these names come from that shared scope. Only `react`
 * survives as a real import, answered by the shell's seeded module table.
 */
import { createElement, useEffect, useSyncExternalStore } from 'react'
import {
  REACT_CAPABILITIES, closeFrame, createFrameState, moveFocus, project, redo, splitFrame,
  undo, withMeasurements, withPlatform,
} from '../../../frames/src/index.ts'
import type { FrameState, FrameTypeDefinition } from '../../../frames/src/index.ts'

/** Services this plugin needs before it activates. */
export const inject = ['slots']

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

/** The core state plus what the overlay needs to draw it. */
interface Snapshot {
  readonly visible: boolean
  readonly view: ReturnType<typeof project>
}

/**
 * One overlay's state. Kept outside React so a resize or a key press can publish
 * without a component owning the layout.
 */
function createController() {
  let platform = { id: 'react', capabilities: REACT_CAPABILITIES }
  let state: FrameState = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform }),
    { viewport: { width: window.innerWidth, height: window.innerHeight } },
  )
  let visible = true
  let snapshot: Snapshot = { visible, view: project(state) }

  const listeners = new Set<() => void>()
  const publish = (): void => {
    snapshot = { visible, view: project(state) }
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
        // The overlay has no chrome to report in, so the console is the feedback.
        console.warn(`[frames] ${result.code}: ${result.message}`)
        return
      }
      state = result.value
      publish()
    },
    toggle(): void {
      visible = !visible
      publish()
    },
    remeasure(): void {
      state = withMeasurements(state, { viewport: { width: window.innerWidth, height: window.innerHeight } })
      publish()
    },
    reset(): void {
      state = withMeasurements(
        createFrameState({ startup: CONVERSATION, platform }),
        { viewport: { width: window.innerWidth, height: window.innerHeight } },
      )
      note = ''
      publish()
    },
    setPlatform(id: string): void {
      platform = id === 'tui'
        ? { id: 'tui', capabilities: { ...REACT_CAPABILITIES, floats: 'overlay', freeRect: false, drag: false } }
        : { id: 'react', capabilities: REACT_CAPABILITIES }
      state = withPlatform(state, platform)
      publish()
    },
    split(): void { this.run(splitFrame(state, undefined, CONVERSATION.id)) },
    close(): void { this.run(closeFrame(state)) },
    undo(): void { this.run(undo(state)) },
    redo(): void { this.run(redo(state)) },
    focus(direction: 'left' | 'right' | 'up' | 'down'): void { this.run(moveFocus(state, direction)) },
    focusPane(paneId: string): void { this.run(focusFrame(state, paneId as never)) },
  }
}

/**
 * The overlay entry: the frame layer alone, with no chrome of its own.
 * @returns the overlay, or nothing while hidden.
 */

/**
 * The overlay entry: the frame layer alone, with no chrome of its own.
 * @returns the overlay, or nothing while hidden.
 */
function createOverlay(controller: ReturnType<typeof createController>) {
  return function FramesOverlay() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

    useEffect(() => {
      const onKey = (event: KeyboardEvent): void => {
        const target = event.target as HTMLElement | null
        if (target !== null && (target.tagName === 'INPUT' || target.isContentEditable)) return
        const chord = `${event.ctrlKey ? 'C-' : ''}${event.altKey ? 'M-' : ''}${event.key.toLowerCase()}`
        if (chord === 'c-x') { event.preventDefault(); controller.toggle(); return }
        const action = chord === 'm-h' ? () => controller.focus('left')
          : chord === 'm-j' ? () => controller.focus('down')
            : chord === 'm-k' ? () => controller.focus('up')
              : chord === 'm-l' ? () => controller.focus('right')
                : chord === 'c-f' ? () => controller.split()
                  : chord === 'c-d' ? () => controller.close()
                    : chord === 'c-u' ? () => controller.undo()
                      : undefined
        if (action === undefined) return
        event.preventDefault()
        action()
      }
      const onResize = (): void => { controller.remeasure() }
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onResize)
      }
    }, [])

    if (!snapshot.visible) return null

    const { view } = snapshot

    const panes = view.docked.map((pane) => createElement('div', {
      key: pane.id,
      onClick: () => controller.focusPane(pane.id),
      style: {
        position: 'absolute',
        boxSizing: 'border-box',
        left: `calc(${pane.rect.x * 100}% + 1px)`,
        top: `calc(${pane.rect.y * 100}% + 1px)`,
        width: `calc(${pane.rect.width * 100}% - 2px)`,
        height: `calc(${pane.rect.height * 100}% - 2px)`,
        background: '#1b1f26',
        border: pane.id === view.active ? '1px solid #6ea8fe' : '1px solid #39404c',
        borderRadius: '6px',
        padding: '8px',
        overflow: 'hidden',
      },
    },
    createElement('div', { key: 't', style: { fontWeight: 600 } }, pane.tabs[0]?.title ?? '(empty pane)'),
    createElement('div', { key: 'm', style: { color: '#8b93a3', marginTop: '4px' } },
      `x ${pane.rect.x.toFixed(2)} · w ${pane.rect.width.toFixed(2)}`),
    ))

    return createElement('div', {
      style: {
        position: 'fixed',
        inset: '0',
        zIndex: 40,
        pointerEvents: 'auto',
        background: '#14161a',
        color: '#d8dbe2',
        font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        display: 'flex',
        flexDirection: 'column',
      },
    },
    createElement('div', { key: 'area', style: { position: 'relative', flex: '1', margin: '10px' } }, panes),
    )
  }
}

/**
 * Register the overlay entry.
 * @param ctx - the client context.
 */
export function apply(ctx: { slots: { inject(key: string, callback: () => unknown): unknown; register(options: unknown, component: unknown): unknown } }): void {
  const controller = createController()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'frames-overlay', order: 100, label: 'Frames' },
    createOverlay(controller),
  ))
}
