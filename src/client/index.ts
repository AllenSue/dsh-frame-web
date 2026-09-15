/**
 * The web renderer plugin.
 *
 * It registers one entry into the shell's `root` slot and draws the core's
 * projection there, filling the window: with the compatibility layer mounted,
 * this *is* the shell.
 *
 * Almost nothing here decides anything. A key chord and a pointer drag both
 * reduce to a `FrameGesture` (see `./gestures.ts`) and both leave through
 * `./execute.ts`, so the renderer owns drawing and hit-testing and nothing else.
 * During a drag it keeps a preview in its own closure and calls neither: the
 * tree changes once, when the pointer is released.
 *
 * The build concatenates this file after the core's modules, so the relative
 * import below is erased and those names come from that shared scope. Only `react`
 * survives as a real import, answered by the shell's seeded module table.
 */
import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { REACT_CAPABILITIES, provideFramesService, project } from '../../../frames/src/index.ts'
import type {
  FrameTypeDefinition, FramesService, NormalizedRect, PaneId, TabId,
} from '../../../frames/src/index.ts'
import {
  chordGesture, dividerDelta, draggedFloatRect, dragSizes, dropPreview, releaseGesture,
  resizedFloatRect,
} from './gestures.ts'
import type { DragSession, FrameGesture, GestureContext, GestureDivider, Point } from './gestures.ts'
import { decideKey, hasSelection, isEditing } from './keys.ts'
import type { TypingTarget } from './keys.ts'
import { createPresetPort } from './presets.ts'
import type { PresetStorage } from './presets.ts'
import { execute } from './execute.ts'

/** Services this plugin needs before it activates. */
export const inject = ['slots']

/** The type the shell opens with. The compatibility layer supplies its body. */
const CONVERSATION: FrameTypeDefinition = { id: 'legacy.conversation', title: () => 'Conversation' }

/** How wide a divider's grab handle is drawn, in pixels. */
const DIVIDER_GRAB = 7

/**
 * The browser medium, when there is one.
 *
 * A non-browser boot of this bundle (a Node e2e composing the client tree) has
 * no `localStorage`, and a shell without presets is a shell that refuses the two
 * preset chords — not a shell that fails to start.
 */
function presetPort(): ReturnType<typeof createPresetPort> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : createPresetPort(localStorage as PresetStorage)
  } catch {
    // Reaching `localStorage` can throw outright when a document is sandboxed
    // without `allow-same-origin`.
    return undefined
  }
}

/**
 * Ask the user for a preset name.
 *
 * `prompt` is the only name-entry affordance a chrome-less shell has. It is the
 * one place a gesture needs the user before it can become an operation, which is
 * why the vocabulary carries `savePresetAs` separately.
 * @param suggested - the name to offer, so re-saving the active preset is one keypress.
 * @returns the name, or `undefined` when the user cancelled or gave nothing.
 */
function askPresetName(suggested: string | undefined): string | undefined {
  const answer = prompt('Save layout as preset', suggested ?? 'default')
  if (answer === null) return undefined
  const name = answer.trim()
  return name === '' ? undefined : name
}

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

/** A pointer position as a fraction of the drawable area. */
const at = (event: { readonly clientX: number; readonly clientY: number }): Point => {
  const extent = viewport()
  return { x: event.clientX / extent.width, y: event.clientY / extent.height }
}

/** What the layer is in the middle of, if anything. Never reaches the tree. */
type Active =
  | { readonly kind: 'chip'; readonly session: DragSession; readonly seed: string }
  | {
    readonly kind: 'float'
    readonly paneId: PaneId
    readonly corner: 'se' | undefined
    readonly start: NormalizedRect
    readonly from: Point
  }
  | { readonly kind: 'divider'; readonly divider: GestureDivider; readonly from: Point }

/** A rectangle as CSS, pinned to the normalized area it describes. */
function area(rect: NormalizedRect): Record<string, string> {
  return {
    position: 'absolute',
    boxSizing: 'border-box',
    left: `calc(${rect.x * 100}% + 1px)`,
    top: `calc(${rect.y * 100}% + 1px)`,
    width: `calc(${rect.width * 100}% - 2px)`,
    height: `calc(${rect.height * 100}% - 2px)`,
  }
}

/**
 * The layer's view of the shared tree.
 *
 * It holds no layout of its own: it subscribes to `ctx.frames` and reports what
 * it measured, so the compatibility layer and any other renderer drive the same
 * tree through the same service.
 * @param service - the frame tree published by this plugin.
 * @returns the readable snapshot plus the one way to change it.
 */
function createController(service: FramesService) {
  let snapshot: Snapshot = { view: service.project() }
  const listeners = new Set<() => void>()

  service.subscribe(() => {
    snapshot = { view: service.project() }
    for (const listener of listeners) listener()
  })
  service.reportMeasurements({ viewport: viewport() })

  const context = (seed: string): GestureContext => {
    const view = snapshot.view
    const focused = view.docked.find((pane) => pane.id === view.active)
    return {
      activePaneId: view.active,
      activeTabId: focused?.tabs.find((tab) => tab.active)?.id,
      seed,
      panes: view.docked.map((pane) => ({ id: pane.id, rect: pane.rect })),
      presets: service.presetNames(),
      activePreset: service.activePresetId(),
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): Snapshot => snapshot,
    /** What a chord or a drag acts on, read fresh from the last projection. */
    context,
    /** The preset in force, which decides what a save offers to overwrite. */
    activePreset(): string | undefined {
      return service.activePresetId()
    },
    /** The type a split seeds with: whatever the focused frame is showing. */
    seed(): string {
      const view = snapshot.view
      const focused = view.docked.find((pane) => pane.id === view.active)
      return focused?.tabs.find((tab) => tab.active)?.typeId ?? CONVERSATION.id
    },
    remeasure(): void {
      service.reportMeasurements({ viewport: viewport() })
    },
    /** Run exactly one gesture. One gesture, one call, one history entry. */
    dispatch(gesture: FrameGesture): void {
      execute(service, gesture)
    },
  }
}

/**
 * The layer entry: the frame tree, drawn as the window itself.
 * @returns the frame layer.
 */
function createLayer(controller: ReturnType<typeof createController>) {
  return function FramesLayer({ renderSlot }: {
    renderSlot(key: 'frames.body', owner: object, options: { entryKey: string }): unknown
  }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    // The preview and the gesture live in this closure. Neither is in the model,
    // so neither can reach a preset or become an undo step of its own.
    const [preview, setPreview] = useState<NormalizedRect | undefined>(undefined)
    const active = useRef<Active | undefined>(undefined)
    const armed = useRef(false)

    useEffect(() => {
      const onMove = (event: PointerEvent): void => {
        const running = active.current
        if (running === undefined) return
        const point = at(event)
        if (running.kind === 'float') {
          const delta = { x: point.x - running.from.x, y: point.y - running.from.y }
          setPreview(running.corner === undefined
            ? draggedFloatRect(running.start, delta)
            : resizedFloatRect(running.start, delta, running.corner))
          return
        }
        if (running.kind === 'divider') return
        const context = controller.context(running.seed)
        const gesture = releaseGesture(running.session, point, context)
        setPreview(gesture.kind === 'drop' ? dropPreview(gesture.target, context.panes) : undefined)
      }

      // The release is the only moment the tree hears about a drag.
      const onUp = (event: PointerEvent): void => {
        const running = active.current
        active.current = undefined
        setPreview(undefined)
        if (running === undefined) return
        const point = at(event)
        if (running.kind === 'chip') {
          controller.dispatch(releaseGesture(running.session, point, controller.context(running.seed)))
          return
        }
        if (running.kind === 'divider') {
          const extent = viewport()
          const delta = dividerDelta(running.divider, {
            x: event.clientX - running.from.x * extent.width,
            y: event.clientY - running.from.y * extent.height,
          }, extent)
          controller.dispatch({
            kind: 'resizeSplit',
            splitId: running.divider.splitId,
            sizes: dragSizes(running.divider, delta),
          })
          return
        }
        const delta = { x: point.x - running.from.x, y: point.y - running.from.y }
        controller.dispatch({
          kind: 'placeFloat',
          paneId: running.paneId,
          rect: running.corner === undefined
            ? draggedFloatRect(running.start, delta)
            : resizedFloatRect(running.start, delta, running.corner),
        })
      }

      const onKey = (event: KeyboardEvent): void => {
        // A frame takes its chords wherever the user is, a text field included:
        // the whole point is to split or float without reaching for the mouse.
        // The one thing a field keeps is a key already working there, which
        // `decideKey` settles — `C-x` with a selection is still cut.
        const target = event.target as (HTMLElement & TypingTarget) | null
        const editing = isEditing(target)
        const decision = decideKey(event, {
          prefix: armed.current,
          editing,
          selected: editing && target !== null
            && hasSelection(target, window.getSelection()?.isCollapsed ?? true),
        })
        armed.current = false

        if (decision.kind === 'ignore') return
        if (decision.kind === 'arm') {
          armed.current = true
          event.preventDefault()
          return
        }
        const gesture = chordGesture(decision.chord, controller.context(controller.seed()))
        if (gesture === undefined) return
        event.preventDefault()
        // The one gesture the UI has to finish: `C-x C-s` names a preset, and a
        // name can only come from the user.
        if (gesture.kind === 'savePresetAs') {
          const name = askPresetName(controller.activePreset())
          if (name !== undefined) controller.dispatch({ kind: 'savePreset', name })
          return
        }
        controller.dispatch(gesture)
      }

      const onResize = (): void => { controller.remeasure() }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onResize)
      }
    }, [])

    const begin = (next: Active): void => { active.current = next }
    const stop = (event: { stopPropagation(): void }): void => { event.stopPropagation() }

    const { view } = snapshot

    const frames = view.docked.map((pane) => {
      const shown = pane.tabs.find((tab) => tab.active) ?? pane.tabs[0]
      // The strip is always drawn: it is the frame's grab handle, and with more
      // than one chip it is also where a chip is picked up and put down.
      const strip = createElement('div', {
        key: 'strip',
        onPointerDown: (event: { stopPropagation(): void }) => {
          stop(event)
          controller.dispatch({ kind: 'focusPane', paneId: pane.id })
        },
        style: {
          display: 'flex',
          flex: '0 0 auto',
          height: '22px',
          borderBottom: '1px solid #39404c',
          background: '#171a20',
          fontSize: '12px',
          overflow: 'hidden',
        },
      }, pane.tabs.map((tab) => createElement('div', {
        key: tab.id,
        onPointerDown: (event: { stopPropagation(): void }) => {
          stop(event)
          controller.dispatch({ kind: 'focusPane', paneId: pane.id })
          begin({
            kind: 'chip',
            session: { tabId: tab.id as TabId, fromPaneId: pane.id },
            seed: tab.typeId,
          })
        },
        style: {
          flex: '0 1 auto',
          maxWidth: '14em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          padding: '3px 8px',
          cursor: 'grab',
          color: tab.active ? '#e6e9ef' : '#98a1b0',
          background: tab.active ? '#2b3442' : 'transparent',
          borderRight: '1px solid #39404c',
        },
      }, tab.title)))

      return createElement('div', {
        key: pane.id,
        // Focus follows a click anywhere in the frame, but the event is *not*
        // stopped: the body is another plugin's content, and swallowing its
        // pointer events would break every control inside it.
        onPointerDown: () => { controller.dispatch({ kind: 'focusPane', paneId: pane.id }) },
        style: {
          ...area(pane.rect),
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
      strip,
      // The frame's content is whatever its type's body supplies; a type with no
      // registered body still shows its title, so an empty frame reads as one.
      createElement('div', {
        key: 'body',
        // The body must be able to fill: a flex child with no basis keeps its
        // content height, which is what left the conversation short of the frame.
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      },
      shown === undefined
        ? '(empty frame)'
        : renderSlot('frames.body', {}, { entryKey: shown.typeId }) ?? shown.title),
      )
    })

    const dividers = view.dividers.map((divider) => createElement('div', {
      key: `${divider.splitId}:${divider.index}`,
      onPointerDown: (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }) => {
        event.preventDefault()
        stop(event)
        begin({
          kind: 'divider',
          divider: {
            splitId: divider.splitId,
            axis: divider.axis,
            index: divider.index,
            sizes: divider.sizes,
            parent: divider.parent,
          },
          from: at(event),
        })
      },
      style: {
        position: 'absolute',
        boxSizing: 'border-box',
        left: divider.axis === 'row' ? `calc(${divider.at * 100}% - ${DIVIDER_GRAB / 2}px)` : '0',
        top: divider.axis === 'row' ? '0' : `calc(${divider.at * 100}% - ${DIVIDER_GRAB / 2}px)`,
        width: divider.axis === 'row' ? `${DIVIDER_GRAB}px` : '100%',
        height: divider.axis === 'row' ? '100%' : `${DIVIDER_GRAB}px`,
        cursor: divider.axis === 'row' ? 'col-resize' : 'row-resize',
        pointerEvents: 'auto',
        zIndex: 2,
      },
    }))

    const floats = view.floats.map((frame) => {
      const drawn = frame.rectHonoured
        ? area(frame.rect)
        : { position: 'absolute', boxSizing: 'border-box', right: '1px', bottom: '1px', width: '40%', height: '50%' }
      const beginMove = (event: { stopPropagation(): void; clientX: number; clientY: number }): void => {
        if (!frame.rectHonoured) return
        stop(event)
        begin({ kind: 'float', paneId: frame.id, corner: undefined, start: frame.rect, from: at(event) })
      }
      return createElement('div', {
        key: frame.id,
        style: {
          ...drawn,
          pointerEvents: 'auto',
          background: '#202531',
          border: '1px solid #5a6272',
          borderRadius: '6px',
          boxShadow: '0 8px 24px rgba(0,0,0,.45)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 3,
        },
      },
      createElement('div', {
        key: 'title',
        onPointerDown: beginMove,
        style: {
          flex: '0 0 auto',
          padding: '4px 8px',
          fontWeight: 600,
          background: '#171a20',
          borderBottom: '1px solid #39404c',
          cursor: frame.rectHonoured ? 'move' : 'default',
        },
      }, frame.tabs[0]?.title ?? '(empty frame)'),
      createElement('div', { key: 'body', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
        frame.tabs[0] === undefined
          ? null
          : renderSlot('frames.body', {}, { entryKey: frame.tabs[0].typeId }) ?? frame.tabs[0].title),
      // The resize handle is the south-east corner, the one a window grows from.
      frame.rectHonoured
        ? createElement('div', {
          key: 'grip',
          onPointerDown: (event: { stopPropagation(): void; clientX: number; clientY: number }) => {
            stop(event)
            begin({ kind: 'float', paneId: frame.id, corner: 'se', start: frame.rect, from: at(event) })
          },
          style: {
            position: 'absolute',
            right: '0',
            bottom: '0',
            width: '14px',
            height: '14px',
            cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 50%, #5a6272 50%)',
          },
        })
        : null,
      )
    })

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
    createElement('div', { key: 'area', style: { position: 'relative', width: '100%', height: '100%' } }, frames, dividers),
    createElement('div', { key: 'floats', style: { position: 'relative', width: '100%', height: '100%', pointerEvents: 'none' } }, floats),
    preview === undefined ? null : createElement('div', {
      key: 'preview',
      style: {
        ...area(preview),
        pointerEvents: 'none',
        background: 'rgba(110,168,254,.18)',
        border: '1px solid #6ea8fe',
        borderRadius: '6px',
        zIndex: 50,
      },
    }),
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
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: unknown, component: unknown): unknown
    provideRoot(face: unknown): () => void
  }
}): void {
  ctx.effect(() => {
    const { service, dispose } = provideFramesService(ctx, {
      startup: CONVERSATION,
      platform: PLATFORM,
      presets: presetPort(),
    })
    const controller = createController(service)
    // The catalog is read once at mount; a preset written by another tab, or by
    // a target that shares the medium, shows up on the next reload rather than
    // costing a poll.
    void service.refreshPresets().catch(() => undefined)
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
      createLayer(controller),
    )
    return () => {
      if (typeof dropLayer === 'function') dropLayer()
      dispose()
    }
  }, 'frames-web: service + layer registration')
}
