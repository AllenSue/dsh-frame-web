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
  FrameTypeDefinition, FramesService, NormalizedRect, PaneId,
} from '../../../frames/src/index.ts'
import {
  chordGesture, dividerDelta, draggedFloatRect, dragSizes, resizedFloatRect,
} from './gestures.ts'
import type { FrameGesture, GestureContext, GestureDivider, Point } from './gestures.ts'
import { decideKey, hasSelection, isEditing } from './keys.ts'
import type { TypingTarget } from './keys.ts'
import { choiceGesture, matchChoices, pickerChoices, pickerKey } from './picker.ts'
import type { PickerChoice, PickerState } from './picker.ts'
import { createPresetPort } from './presets.ts'
import type { PresetStorage } from './presets.ts'
import { execute } from './execute.ts'
import type { Executed } from './execute.ts'

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

  const context = (): GestureContext => {
    const view = snapshot.view
    return {
      activePaneId: view.active,
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
    /** What a chord acts on, read fresh from the last projection. */
    context,
    /** The preset in force, which decides what a save offers to overwrite. */
    activePreset(): string | undefined {
      return service.activePresetId()
    },
    remeasure(): void {
      service.reportMeasurements({ viewport: viewport() })
    },
    /**
     * Run exactly one gesture. One gesture, one call, one history entry.
     *
     * A refused operation changes nothing, which is the core's oldest rule — and
     * a user looking at a screen that did not change learns nothing from a
     * console they are not reading. So the refusal's own words go back to the
     * caller, which is the only side that can put them in front of someone.
     * @param gesture - the semantic operation the user asked for.
     * @param onRefused - told the refusal, when there is one.
     * @returns whether the model accepted it.
     */
    run(gesture: FrameGesture, onRefused: (message: string) => void): Executed {
      return execute(service, gesture, onRefused)
    },
  }
}

/**
 * What an empty frame draws: what can be shown here.
 *
 * Two lists, because there are two questions. **Open** is what the shell already
 * holds — a content with no frame on it is still alive, and this is where it
 * comes back. **New** is what can be made. The renderer decides nothing about
 * either: both come from the projection, which is what the core was told.
 *
 * The same rows feed the `C-x b` dialog below; this is the version with nowhere
 * to type, drawn in the frame that has nothing in it.
 * @param view - the projection, for the contents and the registered types.
 * @param paneId - the frame the choice is for.
 * @param controller - the one way a gesture becomes a change.
 * @returns the picker, or a note when there is nothing at all to show.
 */
function createPicker(
  view: Snapshot['view'],
  paneId: PaneId,
  onPick: (gesture: FrameGesture) => void,
): unknown {
  const choices = pickerChoices(view)
  if (choices.length === 0) {
    return createElement('div', {
      style: { padding: '12px', color: '#98a1b0' },
    }, 'Nothing to show: no plugin has registered a content or a type.')
  }

  const row = (choice: PickerChoice): unknown => createElement('div', {
    key: `${choice.group}:${choice.id}`,
    onClick: () => { onPick(choiceGesture(choice, paneId)) },
    style: {
      cursor: 'pointer',
      padding: '4px 8px',
      border: '1px solid #39404c',
      borderRadius: '4px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }, choice.title)

  const section = (title: string, group: PickerChoice['group']): unknown => {
    const entries = choices.filter((choice) => choice.group === group)
    return entries.length === 0
      ? null
      : createElement('div', { key: title, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        createElement('div', { key: 'h', style: { color: '#98a1b0' } }, title),
        entries.map(row))
  }

  return createElement('div', {
    style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'auto' },
  },
  section('Open', 'open'),
  section('New', 'new'))
}

/** What the `C-x b` dialog needs to run itself. */
interface PickerDialogProps {
  readonly state: PickerState
  readonly choices: readonly PickerChoice[]
  /** A new query, cursor back at the top of what it leaves. */
  setQuery(query: string): void
  /** Move the cursor, wrapping at both ends. */
  move(key: 'up' | 'down'): void
  /** Put the cursor on one row — what a pointer hovering it means. */
  hover(index: number): void
  /** Take a row, or close when there is none. */
  choose(choice: PickerChoice | undefined): void
  close(): void
}

/**
 * The `C-x b` dialog.
 *
 * A query box over the list it filters, because the alternative — a browser
 * `prompt` — asks a person to remember a name and type it exactly. The list is
 * the answer to "what is there", and the query is how it is narrowed.
 *
 * It is a modal on purpose. Chords otherwise work everywhere, typing fields
 * included; here every keystroke belongs to the query, so the key layer stands
 * down while this is open and the box keeps only what it needs: arrows, Enter,
 * and Escape.
 * @param props - the query, the rows it leaves, and what the keys do.
 * @returns the dialog.
 */
function createPickerDialog({
  state, choices, setQuery, move, hover, choose, close,
}: PickerDialogProps): unknown {
  const chosen = choices[state.index]
  const stop = (event: { stopPropagation(): void }): void => { event.stopPropagation() }

  const onKeyDown = (event: {
    readonly key: string
    readonly shiftKey: boolean
    preventDefault(): void
  }): void => {
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      move('down')
      return
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      move('up')
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(chosen)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const row = (choice: PickerChoice, index: number): unknown => {
    const on = index === state.index
    return createElement('div', {
      key: `${choice.group}:${choice.id}`,
      onPointerEnter: () => { hover(index) },
      onClick: () => { choose(choice) },
      style: {
        cursor: 'pointer',
        padding: '6px 10px',
        borderRadius: '4px',
        background: on ? '#2b3442' : 'transparent',
        color: on ? '#e6e9ef' : '#c3c9d4',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }, choice.title)
  }

  const section = (title: string, group: PickerChoice['group']): unknown => {
    const entries = choices
      .map((choice, index) => ({ choice, index }))
      .filter((entry) => entry.choice.group === group)
    return entries.length === 0
      ? null
      : createElement('div', { key: title, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        createElement('div', {
          key: 'h',
          style: { padding: '6px 10px 2px', color: '#98a1b0', fontSize: '11px', textTransform: 'uppercase' },
        }, title),
        entries.map((entry) => row(entry.choice, entry.index)))
  }

  return createElement('div', {
    key: 'picker',
    onPointerDown: close,
    style: {
      position: 'fixed',
      inset: '0',
      zIndex: 60,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      background: 'rgba(10, 12, 16, .55)',
      pointerEvents: 'auto',
    },
  },
  createElement('div', {
    key: 'panel',
    onPointerDown: stop,
    style: {
      marginTop: '12vh',
      width: 'min(560px, 90vw)',
      maxHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#1b1f26',
      border: '1px solid #4a5364',
      borderRadius: '8px',
      boxShadow: '0 12px 32px rgba(0,0,0,.5)',
      overflow: 'hidden',
    },
  },
  createElement('input', {
    key: 'query',
    autoFocus: true,
    value: state.query,
    placeholder: 'Show content…',
    spellCheck: false,
    onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
    onKeyDown,
    style: {
      flex: '0 0 auto',
      padding: '10px 12px',
      background: 'transparent',
      border: 'none',
      borderBottom: '1px solid #39404c',
      color: '#e6e9ef',
      font: 'inherit',
      outline: 'none',
    },
  }),
  createElement('div', {
    key: 'list',
    style: { flex: '1 1 auto', minHeight: '0', overflowY: 'auto', padding: '4px' },
  },
  choices.length === 0
    ? createElement('div', { key: 'empty', style: { padding: '10px 12px', color: '#98a1b0' } },
      state.query.trim() === ''
        ? 'Nothing to show: no plugin has registered a content or a type.'
        : `Nothing matches “${state.query.trim()}”.`)
    : [section('Open', 'open'), section('New', 'new')]),
  createElement('div', {
    key: 'hint',
    style: { flex: '0 0 auto', padding: '6px 12px', borderTop: '1px solid #39404c', color: '#98a1b0', fontSize: '11px' },
  }, '↑↓ move · Enter open · Esc close'),
  ))
}

/**
 * The layer entry: the frame tree, drawn as the window itself.
 * @returns the frame layer.
 */
function createLayer(controller: ReturnType<typeof createController>) {
  return function FramesLayer({ renderSlot }: {
    renderSlot(key: 'frames.body', owner: object, options: { entryKey: string }): unknown
    /**
     * The overlay seat. Unlike a body it is not tied to a frame: it is drawn
     * whether or not any frame exists, which is what a content that nothing is
     * displaying hangs on while it keeps running.
     */
    renderSlot(key: 'frames.overlay', owner: object): unknown
  }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    // The preview and the gesture live in this closure. Neither is in the model,
    // so neither can reach a preset or become an undo step of its own.
    const [preview, setPreview] = useState<NormalizedRect | undefined>(undefined)
    const active = useRef<Active | undefined>(undefined)
    const armed = useRef(false)
    // The `C-x b` picker lives here for the same reason: what a person is in the
    // middle of choosing is not part of any layout. The key listener is installed
    // once, so it reads whether the picker is open through a ref — a closure over
    // the state would stay on the first render's `undefined` forever.
    const [picker, setPicker] = useState<PickerState | undefined>(undefined)
    const pickerOpen = useRef(false)
    pickerOpen.current = picker !== undefined
    // Why the last thing that did nothing did nothing. A refused operation is
    // never silent — the console is not where the user is looking.
    const [notice, setNotice] = useState<string | undefined>(undefined)
    /**
     * Run one gesture, and say so on screen when the tree refuses it.
     * @param gesture - the semantic operation to carry out.
     */
    const run = (gesture: FrameGesture): void => {
      const outcome = controller.run(gesture, (message) => { setNotice(message) })
      if (outcome === true) setNotice(undefined)
    }
    useEffect(() => {
      if (notice === undefined) return
      const timer = setTimeout(() => { setNotice(undefined) }, 6000)
      return () => { clearTimeout(timer) }
    }, [notice])

    useEffect(() => {
      const onMove = (event: PointerEvent): void => {
        const running = active.current
        if (running === undefined) return
        if (running.kind === 'divider') return
        const point = at(event)
        const delta = { x: point.x - running.from.x, y: point.y - running.from.y }
        setPreview(running.corner === undefined
          ? draggedFloatRect(running.start, delta)
          : resizedFloatRect(running.start, delta, running.corner))
      }

      // The release is the only moment the tree hears about a drag.
      const onUp = (event: PointerEvent): void => {
        const running = active.current
        active.current = undefined
        setPreview(undefined)
        if (running === undefined) return
        const point = at(event)
        if (running.kind === 'divider') {
          const extent = viewport()
          const delta = dividerDelta(running.divider, {
            x: event.clientX - running.from.x * extent.width,
            y: event.clientY - running.from.y * extent.height,
          }, extent)
          run({
            kind: 'resizeSplit',
            splitId: running.divider.splitId,
            sizes: dragSizes(running.divider, delta),
          })
          return
        }
        const delta = { x: point.x - running.from.x, y: point.y - running.from.y }
        run({
          kind: 'placeFloat',
          paneId: running.paneId,
          rect: running.corner === undefined
            ? draggedFloatRect(running.start, delta)
            : resizedFloatRect(running.start, delta, running.corner),
        })
      }

      const onKey = (event: KeyboardEvent): void => {
        // The picker is modal: every keystroke belongs to its query box, so the
        // chords stand down while it is open. Escape still closes it here rather
        // than only in the box, because a click on a row can take the focus out
        // of that box.
        if (pickerOpen.current) {
          if (event.key === 'Escape') {
            event.preventDefault()
            setPicker(undefined)
          }
          return
        }
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
        const gesture = chordGesture(decision.chord, controller.context())
        if (gesture === undefined) return
        event.preventDefault()
        // One gesture the UI has to finish: `C-x C-s` names a preset, and a new
        // name can only come from the user.
        if (gesture.kind === 'savePresetAs') {
          const name = askPresetName(controller.activePreset())
          if (name !== undefined) run({ kind: 'savePreset', name })
          return
        }
        // And the other: `C-x b` asks for a content or a type, and the answer is
        // a choice — so it opens the picker over the pane that had focus, and the
        // choice itself becomes the gesture.
        if (gesture.kind === 'pickContent') {
          const paneId = controller.context().activePaneId
          if (paneId === undefined) return
          setPicker({ paneId, query: '', index: 0 })
          return
        }
        run(gesture)
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

    // What the `C-x b` dialog is showing: the rows the projection offers, cut
    // down by the query. Computed from the live view rather than captured when
    // the dialog opened, so a content a plugin registers while it is up is
    // offered too.
    const choices = picker === undefined ? [] : matchChoices(pickerChoices(view), picker.query)

    // The overlay seat is drawn whether or not any frame exists; it is what a
    // content that nothing is displaying hangs on.
    const overlay = renderSlot('frames.overlay', {})

    const frames = view.docked.map((pane) => {
      const shown = pane.content
      return createElement('div', {
        key: pane.id,
        // Focus follows a click anywhere in the frame, but the event is *not*
        // stopped: the body is another plugin's content, and swallowing its
        // pointer events would break every control inside it.
        onPointerDown: () => { run({ kind: 'focusPane', paneId: pane.id }) },
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
      // The frame draws no chrome: it *is* the body. One frame, one content —
      // and a content that has tabs inside it (an editor with its files, a panel
      // with its pages) draws them itself, because they are its own state. A
      // frame waiting for a choice offers one instead of a body.
      createElement('div', {
        key: 'body',
        // The body must be able to fill: a flex child with no basis keeps its
        // content height, which is what left the conversation short of the frame.
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      },
      shown === undefined
        ? createPicker(view, pane.id, run)
        : renderSlot(
          'frames.body',
          { rect: pane.rect, viewport: viewport(), focused: pane.id === view.active },
          { entryKey: shown.typeId },
        ) ?? shown.title),
      )
    })

    // Only the dividers that can move are drawn: the core carries a fixed
    // column's share over whatever a drag asks for, so offering a grab handle on
    // its edge would be offering a gesture that does nothing to the boundary the
    // pointer is holding (the projection says which ones those are).
    const dividers = view.dividers.filter((divider) => divider.movable).map((divider) => createElement('div', {
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
      }, frame.content?.title ?? '(empty frame)'),
      createElement('div', { key: 'body', style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
        frame.content === undefined
          ? null
          : renderSlot(
            'frames.body',
            { rect: frame.rect, viewport: viewport(), focused: frame.id === view.active },
            { entryKey: frame.content.typeId },
          ) ?? frame.content.title),
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
    // The overlay layer. It is drawn after the panes so an occupant here can
    // cover the column it was given, and before the floating frames so a window
    // still goes on top of it — the same order the shipped shell had, where the
    // right column sat below the overlays and the overlays below the floats.
    //
    // The layer takes no pointer events of its own: an occupant positions itself
    // and turns them back on for the part of the screen it actually covers.
    createElement('div', {
      key: 'overlay',
      style: { position: 'absolute', inset: '0', zIndex: 2, pointerEvents: 'none' },
    }, overlay),
    // A refusal, in the user's field of view rather than in the console. It says
    // what the tree said, because the tree's words are the only ones that know
    // *why* nothing happened.
    notice === undefined ? null : createElement('div', {
      key: 'notice',
      style: {
        position: 'fixed',
        top: '0',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 55,
        maxWidth: '90vw',
        padding: '4px 10px',
        background: '#3a2226',
        border: '1px solid #a05252',
        borderTop: 'none',
        borderRadius: '0 0 6px 6px',
        color: '#ffd9d9',
        font: '12px/1.4 ui-monospace, monospace',
        pointerEvents: 'none',
      },
    }, notice),
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
    // The `C-x b` dialog, drawn above everything the layer owns: while it is open
    // it is the only thing taking input, so it has to be the topmost thing drawn.
    picker === undefined ? null : createPickerDialog({
      state: picker,
      choices,
      setQuery: (query) => { setPicker({ ...picker, query, index: 0 }) },
      move: (key) => { setPicker(pickerKey(picker, choices, key)) },
      hover: (index) => { setPicker({ ...picker, index }) },
      choose: (choice) => {
        setPicker(undefined)
        if (choice !== undefined) run(choiceGesture(choice, picker.paneId))
      },
      close: () => { setPicker(undefined) },
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
        //
        // The overlay seat is its sibling, and it is deliberately not keyed by a
        // type: it belongs to no frame, so an occupant registered here is drawn
        // even while nothing displays it — a content that has to keep running
        // with no window on it hangs on this.
        children: {
          'frames.body': { kind: 'keyed', scope: 'root' },
          'frames.overlay': { kind: 'list', scope: 'root' },
        },
      },
      createLayer(controller),
    )
    return () => {
      if (typeof dropLayer === 'function') dropLayer()
      dispose()
    }
  }, 'frames-web: service + layer registration')
}
