/**
 * The pointer half of the frame language.
 *
 * A pointer drag and a key chord must end in the same place, so neither one is
 * allowed to talk to the frame tree directly: both reduce to one vocabulary of
 * `FrameGesture` values, and the renderer's only job is to run the value the
 * layer produced. That is what makes "one gesture, one semantic operation" true
 * by construction rather than by discipline — a drag cannot record two history
 * entries, because it never records anything itself.
 *
 * Everything here is a pure function of numbers, so the entire gesture surface
 * is asserted without a DOM. During a drag the layer keeps its own preview and
 * calls none of this until the pointer is released.
 */
import type {
  DropTarget, FocusDirection, NormalizedRect, PaneId, SplitId, TabId,
} from '../../../frames/src/index.ts'
import {
  clampFloatRect, clampSizes, DOCK_EDGE_FRACTION, zoneAt,
} from '../../../frames/src/index.ts'
import type { Chord } from './keys.ts'

// The chord vocabulary belongs to the key layer; re-exported here because a
// chord and the gesture it names are read together by whoever wires the key map.
export type { Chord } from './keys.ts'

/** A point in fractions of the drawable area. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** A pane as the gesture layer sees it: an identity and the area it occupies. */
export interface GesturePane {
  readonly id: PaneId
  readonly rect: NormalizedRect
}

/** A divider as the gesture layer sees it. */
export interface GestureDivider {
  readonly splitId: SplitId
  readonly axis: 'row' | 'column'
  /** Which divider of the split this is: it sits after child `index`. */
  readonly index: number
  readonly sizes: readonly number[]
  /** The split's own area; a share is a fraction of this, not of the window. */
  readonly parent: NormalizedRect
}

/** What the layer needs to know about the tree to name what a gesture acts on. */
export interface GestureContext {
  /** The focused pane; a chord acts on it. */
  readonly activePaneId: PaneId | undefined
  /** The focused pane's active chip; a chord drags it. */
  readonly activeTabId: TabId | undefined
  /** The type that backfills a pane a gesture would otherwise empty. */
  readonly seed: string
  /** The docked panes as drawn. */
  readonly panes: readonly GesturePane[]
  /** Preset names the medium holds, in name order. */
  readonly presets: readonly string[]
  /** The preset in force, when the layout came from one. */
  readonly activePreset: string | undefined
  /** Contents the shell holds, whether or not a frame is showing one. */
  readonly contents: readonly GestureContent[]
  /** Registered types, in registration order; a picker lists the instantiable ones. */
  readonly types: readonly GestureType[]
}

/** A content, as a switch would name it. */
export interface GestureContent {
  readonly id: string
  readonly kind: string
  readonly title: string
}

/** A registered type, as a picker lists it. */
export interface GestureType {
  readonly id: string
  readonly title: string
  readonly instantiable: boolean
}

/**
 * One semantic operation, named but not yet performed.
 *
 * The chord and the pointer produce values of this one type, so the renderer has
 * exactly one place where a gesture becomes a call on the frame service.
 */
export type FrameGesture =
  /**
   * Split the focused pane; the key map's own way to make a new frame.
   *
   * The new frame is **empty**, and an empty frame offers what can be made in
   * it. Seeding it with the type already beside it would be a copy — the thing
   * a person asked for is a frame, and what goes in it is the next question.
   */
  | {
    readonly kind: 'split'
    readonly paneId: PaneId
    readonly axis: 'row' | 'column'
  }
  /** Release a dragged chip: what the pointer does instead. */
  | { readonly kind: 'drop'; readonly tabId: TabId; readonly target: DropTarget; readonly seed: string }
  /** Move a chip to another caret slot in a strip. */
  | { readonly kind: 'placeTab'; readonly tabId: TabId; readonly paneId: PaneId; readonly index: number }
  | { readonly kind: 'close'; readonly paneId: PaneId }
  | { readonly kind: 'float'; readonly paneId: PaneId }
  | { readonly kind: 'dock'; readonly paneId: PaneId }
  | { readonly kind: 'focus'; readonly direction: FocusDirection }
  | { readonly kind: 'focusPane'; readonly paneId: PaneId }
  | { readonly kind: 'resizeSplit'; readonly splitId: SplitId; readonly sizes: readonly number[] }
  | { readonly kind: 'placeFloat'; readonly paneId: PaneId; readonly rect: NormalizedRect }
  /** Save the current tree under `name`. */
  | { readonly kind: 'savePreset'; readonly name: string }
  /** Adopt the stored preset `name`. */
  | { readonly kind: 'applyPreset'; readonly name: string }
  /**
   * Save, but under a name the user has not given yet.
   *
   * This is the one gesture that is not yet an operation: only the UI can ask
   * for a name, so the renderer turns it into `savePreset` before dispatching
   * and `execute` never sees it. It stays in the union so that a new caller
   * cannot silently drop it.
   */
  | { readonly kind: 'savePresetAs' }
  /** Show an existing content in a pane. */
  | { readonly kind: 'showContent'; readonly paneId: PaneId; readonly contentId: string }
  /** Make one new instance of a type and show it in a pane. */
  | { readonly kind: 'createContent'; readonly typeId: string; readonly paneId: PaneId }
  /**
   * Bring a content up, by a name only the user can supply.
   *
   * `switch-to-buffer`, and the same shape as `savePresetAs`: the renderer asks
   * for the name and resolves it to one of the two gestures above. Either answer
   * is legitimate — naming something already made shows it, naming a type makes
   * another one — which is why one chord covers both.
   */
  | { readonly kind: 'pickContent' }

/**
 * Which preset a switch should land on.
 *
 * Cycling rather than picking, because the key map has one chord for it and no
 * chrome to pick from: `C-x s` walks the catalog and wraps. A layout that is on
 * no preset — or on one that has since been deleted — starts at the first.
 * @param presets - the names the medium holds, in name order.
 * @param active - the preset in force.
 * @returns the next name, or `undefined` when there is nothing to switch to.
 */
export function nextPreset(
  presets: readonly string[],
  active: string | undefined,
): string | undefined {
  if (presets.length === 0) return undefined
  const index = active === undefined ? -1 : presets.indexOf(active)
  return presets[(index + 1) % presets.length]
}

/**
 * What a typed answer means.
 *
 * One command covers "show me that" and "make me one", because a person naming
 * a thing should not have to say which it is. An exact id wins over a title, and
 * a content already made wins over making another — the same preference
 * `switch-to-buffer` has, and the one that does not quietly pile up duplicates.
 * @param answer - what the user typed.
 * @param context - the contents and types the shell knows.
 * @param paneId - the pane it would be shown in.
 * @returns the gesture, or `undefined` when nothing answers to that name.
 */
export function pickContent(
  answer: string,
  context: GestureContext,
  paneId: PaneId,
): FrameGesture | undefined {
  const wanted = answer.trim()
  if (wanted === '') return undefined
  const lower = wanted.toLowerCase()

  const byId = context.contents.find((content) => content.id === wanted)
  if (byId !== undefined) return { kind: 'showContent', paneId, contentId: byId.id }

  const typeById = context.types.find((type) => type.id === wanted && type.instantiable)
  if (typeById !== undefined) return { kind: 'createContent', paneId, typeId: typeById.id }

  const byTitle = context.contents.find((content) => content.title.toLowerCase() === lower)
  if (byTitle !== undefined) return { kind: 'showContent', paneId, contentId: byTitle.id }

  const typeByTitle = context.types.find((type) => type.instantiable && type.title.toLowerCase() === lower)
  return typeByTitle === undefined
    ? undefined
    : { kind: 'createContent', paneId, typeId: typeByTitle.id }
}

/**
 * The gesture a chord asks for, or none when the chord is not bound.
 *
 * Only two splits are bound. Up and left are the pointer's job — a drag names
 * the side by where it lands, which no chord has to encode.
 * @param chord - the chord, in the design's notation.
 * @param context - what the chord acts on.
 * @returns the gesture, or `undefined` for an unbound chord or a missing target.
 */
export function chordGesture(chord: Chord, context: GestureContext): FrameGesture | undefined {
  const split = (axis: 'row' | 'column'): FrameGesture | undefined =>
    context.activePaneId === undefined
      ? undefined
      : { kind: 'split', paneId: context.activePaneId, axis }
  switch (chord) {
    case 'C-x right': return split('row')
    case 'C-x down': return split('column')
    case 'C-x f':
      return context.activePaneId === undefined
        ? undefined
        : { kind: 'float', paneId: context.activePaneId }
    case 'C-x d':
      return context.activePaneId === undefined
        ? undefined
        : { kind: 'dock', paneId: context.activePaneId }
    case 'C-x C-d':
      return context.activePaneId === undefined
        ? undefined
        : { kind: 'close', paneId: context.activePaneId }
    case 'C-x C-s': return { kind: 'savePresetAs' }
    case 'C-x b': return { kind: 'pickContent' }
    case 'C-x s': {
      const name = nextPreset(context.presets, context.activePreset)
      return name === undefined ? undefined : { kind: 'applyPreset', name }
    }
    case 'M-h': return { kind: 'focus', direction: 'left' }
    case 'M-j': return { kind: 'focus', direction: 'down' }
    case 'M-k': return { kind: 'focus', direction: 'up' }
    case 'M-l': return { kind: 'focus', direction: 'right' }
    default: return undefined
  }
}

/** Whether a point falls inside a rectangle, edges included at the near side. */
export function contains(rect: NormalizedRect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height
}

/**
 * Which pane and region a pointer released over.
 *
 * The edge bands are the engine's own, so a release that the preview drew as a
 * split is the release the model carries out.
 * @param panes - the docked panes as drawn.
 * @param point - where the pointer is, in fractions of the drawable area.
 * @param band - edge band width as a share of a pane; defaults to the kit's.
 * @returns the dock target, or `undefined` when the pointer is over no pane —
 *   which is what "take it out into a window" means.
 */
export function dropTargetAt(
  panes: readonly GesturePane[],
  point: Point,
  band: number = DOCK_EDGE_FRACTION,
): DropTarget | undefined {
  const pane = panes.find((candidate) => contains(candidate.rect, point))
  if (pane === undefined) return undefined
  // A release exactly on the far edge of the last pane is inside the whole area
  // but one unit outside that pane's own frame; pinning the share keeps `zoneAt`
  // on its own domain.
  const u = Math.min(1, Math.max(0, (point.x - pane.rect.x) / pane.rect.width))
  const v = Math.min(1, Math.max(0, (point.y - pane.rect.y) / pane.rect.height))
  return { kind: 'dock', paneId: pane.id, zone: zoneAt(u, v, band) }
}

/** A drag in progress. It holds no tree state and is thrown away on release. */
export interface DragSession {
  readonly tabId: TabId
  readonly fromPaneId: PaneId
}

/**
 * The gesture a release produces.
 *
 * This is the only place a drag becomes an operation, and it runs once, on
 * release: every intermediate pointer position is a preview and nothing else.
 * @param session - the chip being dragged.
 * @param point - where the pointer let go.
 * @param context - the drawn panes and the seeding type.
 * @returns the release gesture; over nothing, the chip becomes a window.
 */
export function releaseGesture(
  session: DragSession,
  point: Point,
  context: GestureContext,
): FrameGesture {
  return {
    kind: 'drop',
    tabId: session.tabId,
    target: dropTargetAt(context.panes, point) ?? { kind: 'float' },
    seed: context.seed,
  }
}

/**
 * The area a release would hand the dragged frame, for the preview to draw.
 *
 * The preview is computed from the same rule the drop uses, so what is drawn is
 * what happens. A release over nothing has no docked area to draw.
 * @param target - the release target.
 * @param panes - the docked panes as drawn.
 * @returns the rectangle the frame would fill, or `undefined` over nothing.
 */
export function dropPreview(
  target: DropTarget,
  panes: readonly GesturePane[],
): NormalizedRect | undefined {
  if (target.kind === 'float') return undefined
  const pane = panes.find((candidate) => candidate.id === target.paneId)
  if (pane === undefined) return undefined
  const { rect } = pane
  const half = (side: 'left' | 'top'): NormalizedRect => (side === 'left'
    ? { x: rect.x, y: rect.y, width: rect.width / 2, height: rect.height }
    : { x: rect.x, y: rect.y, width: rect.width, height: rect.height / 2 })
  const farHalf = (side: 'right' | 'bottom'): NormalizedRect => (side === 'right'
    ? { x: rect.x + rect.width / 2, y: rect.y, width: rect.width / 2, height: rect.height }
    : { x: rect.x, y: rect.y + rect.height / 2, width: rect.width, height: rect.height / 2 })
  switch (target.zone) {
    case 'center': return rect
    case 'left': return half('left')
    case 'top': return half('top')
    case 'right': return farHalf('right')
    case 'bottom': return farHalf('bottom')
    default: return undefined
  }
}

/**
 * Pointer movement along a divider's axis, as a fraction of the split.
 *
 * A share is a fraction of the split, which is itself a fraction of the window,
 * so a pixel delta has to be divided twice. Keeping that here means the preview
 * and the recorded sizes cannot disagree about the unit.
 * @param divider - the divider being dragged.
 * @param delta - pointer movement in the renderer's own unit.
 * @param viewport - the drawable area in that unit.
 * @returns movement in the unit a split's shares are expressed in.
 */
export function dividerDelta(
  divider: GestureDivider,
  delta: Point,
  viewport: { readonly width: number; readonly height: number },
): number {
  if (divider.axis === 'row') {
    return viewport.width === 0 || divider.parent.width === 0 ? 0 : (delta.x / viewport.width) / divider.parent.width
  }
  return viewport.height === 0 || divider.parent.height === 0 ? 0 : (delta.y / viewport.height) / divider.parent.height
}

/**
 * Where a divider drag leaves a split's shares.
 *
 * Only the two children the divider separates can move, and they move by equal
 * and opposite amounts, so the split keeps its total. The engine's own floor is
 * applied here rather than at the release, so the preview and the recorded sizes
 * agree.
 * @param divider - the divider being dragged.
 * @param delta - movement along the split's axis, as a fraction of the split.
 * @returns the shares the drag reached.
 */
export function dragSizes(
  divider: GestureDivider,
  delta: number,
): readonly number[] {
  const { index, sizes } = divider
  const before = sizes[index]
  const after = sizes[index + 1]
  if (before === undefined || after === undefined) return sizes
  const next = [...sizes]
  next[index] = before + delta
  next[index + 1] = after - delta
  return clampSizes(next)
}

/**
 * The rectangle a floating frame is dragged to.
 * @param start - where the frame was when the drag began.
 * @param delta - pointer movement, as a fraction of the drawable area.
 * @returns the rectangle, kept inside the area.
 */
export function draggedFloatRect(start: NormalizedRect, delta: Point): NormalizedRect {
  return clampFloatRect({ ...start, x: start.x + delta.x, y: start.y + delta.y })
}

/**
 * The rectangle a floating frame is resized to.
 *
 * The width and height deltas are applied to the named corner; the opposite
 * corner stays put, which is what a resize handle promises.
 * @param start - the frame's rectangle when the drag began.
 * @param delta - pointer movement, as a fraction of the drawable area.
 * @param corner - the corner the handle belongs to.
 * @returns the rectangle, kept inside the area and above the size floor.
 */
export function resizedFloatRect(
  start: NormalizedRect,
  delta: Point,
  corner: 'se' | 'sw' | 'ne' | 'nw',
): NormalizedRect {
  const east = corner === 'se' || corner === 'ne'
  const south = corner === 'se' || corner === 'sw'
  // The clamped size is settled first, because resizing from a western or
  // northern corner derives the origin from it: a floor that shrinks the size
  // must also move the edge the user is not holding.
  const size = clampFloatRect({
    x: 0,
    y: 0,
    width: start.width + (east ? delta.x : -delta.x),
    height: start.height + (south ? delta.y : -delta.y),
  })
  return clampFloatRect({
    x: east ? start.x : start.x + start.width - size.width,
    y: south ? start.y : start.y + start.height - size.height,
    width: size.width,
    height: size.height,
  })
}

/**
 * Which caret slot a pointer sits at in a strip of `count` chips.
 * @param local - pointer x as a fraction of the strip's own width.
 * @param chip - one chip's width as a fraction of that same strip.
 * @param count - chips currently in the strip.
 * @returns the caret slot, counted over the chips as drawn.
 */
export function caretIndex(local: number, chip: number, count: number): number {
  if (chip <= 0) return count
  const slot = Math.round(local / chip)
  return Math.min(Math.max(0, slot), count)
}
