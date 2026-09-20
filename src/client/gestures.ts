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
 *
 * It is the *frame* that is dragged, never a tab. A shell that shows one content
 * per frame has no chip to pick up, so the pointer names a divider or a floating
 * frame and nothing else — moving a content between frames is a service call
 * (`showContent`), which a plugin's own tab strip makes as readily as the shell
 * could.
 */
import type {
  FocusDirection, NormalizedRect, PaneId, SplitId,
} from '../../../frames/src/index.ts'
import { clampFloatRect, clampSizes } from '../../../frames/src/index.ts'
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

/**
 * What the layer needs to know about the tree to name what a gesture acts on.
 *
 * Deliberately small, and it shrank when the tab strip went: there is no focused
 * chip to drag and no pane list to drop onto, so what is left is the focused
 * frame and the preset catalog.
 */
export interface GestureContext {
  /** The focused pane; a chord acts on it. */
  readonly activePaneId: PaneId | undefined
  /** Preset names the medium holds, in name order. */
  readonly presets: readonly string[]
  /** The preset in force, when the layout came from one. */
  readonly activePreset: string | undefined
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
  /** Close the frame: its content is put down, not destroyed. */
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
  /** Show a content in a pane, replacing what that frame was displaying. */
  | { readonly kind: 'showContent'; readonly paneId: PaneId; readonly contentId: string }
  /** Make one new instance of a type and show it in a pane — the same swap. */
  | { readonly kind: 'createContent'; readonly typeId: string; readonly paneId: PaneId }
  /**
   * Bring a content up, by a choice only the user can make.
   *
   * `switch-to-buffer`, and the same shape as `savePresetAs`: the renderer asks,
   * and resolves the answer to one of the two gestures above. Either answer is
   * legitimate — choosing something already made shows it, choosing a type makes
   * another one — which is why one chord covers both. How the asking is done is
   * the renderer's business: `./picker.ts` owns the list and its query.
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
