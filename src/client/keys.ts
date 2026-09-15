/**
 * What a keystroke means to the frame layer.
 *
 * Two things make this its own module rather than a few lines inside the
 * renderer. The first is that the rule is not obvious: `C-x` is the browser's
 * *cut*, so whether it opens the prefix or is left alone depends on whether the
 * user has text selected, and that decision is worth asserting. The second is
 * that the decision reads only a handful of numbers and flags, so it can be
 * tested without a DOM — the renderer is left with the adapter, not the policy.
 *
 * The operator's rule: **a chord fires wherever the user is, including inside a
 * text field.** The only thing a text field keeps for itself is a key that is
 * already doing something there — `C-x` with a selection is cut.
 */

/** The part of a key event this layer reads. `KeyboardEvent` satisfies it. */
export interface KeyStroke {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
}

/** The part of an event target this layer reads. `HTMLElement` satisfies it. */
export interface TypingTarget {
  readonly tagName: string
  readonly isContentEditable?: boolean
  /** Present on `<input>` and `<textarea>`; absent on a rich editor. */
  readonly selectionStart?: number | null
  readonly selectionEnd?: number | null
}

/** A chord in the default key map, written the way the design writes it. */
export type Chord =
  | 'C-x down' | 'C-x right'
  | 'C-x f' | 'C-x d'
  | 'C-x C-d'
  | 'M-h' | 'M-j' | 'M-k' | 'M-l'

/** What the layer should do with one keystroke. */
export type KeyDecision =
  /** Not ours: leave the event entirely alone. */
  | { readonly kind: 'ignore' }
  /** `C-x` opened the prefix; wait for the chord's second key. */
  | { readonly kind: 'arm' }
  /** Run this chord. */
  | { readonly kind: 'chord'; readonly chord: Chord }

/** Whether this target is a text field the user is typing into. */
export function isEditing(target: TypingTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  return target.isContentEditable === true
}

/**
 * Whether the user has text selected in `target`.
 *
 * A plain field reports offsets; a rich editor reports none, so its selection
 * comes from `window.getSelection()` as `collapsed`. The renderer passes that
 * in, which is what keeps this function free of the DOM.
 * @param target - the field the keystroke landed in.
 * @param collapsed - what the document selection reports, for rich editors.
 * @returns whether there is something to cut.
 */
export function hasSelection(target: TypingTarget, collapsed: boolean): boolean {
  const { selectionStart, selectionEnd } = target
  if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
    return selectionStart !== selectionEnd
  }
  return !collapsed
}

/**
 * Read a key event as a chord, or `undefined` when it is not one.
 *
 * `C-x` arms the default map's prefix, and the chord after it may carry a second
 * modifier, so `C-x C-d` closes while `C-x d` docks. Only two splits are bound:
 * up and left are the pointer's job, because a drag names the side by landing on
 * it and no chord has to encode that.
 * @param stroke - the key event, narrowed to what is read.
 * @param prefix - whether `C-x` was pressed just before.
 * @returns the chord, in the design's notation.
 */
export function readChord(stroke: KeyStroke, prefix: boolean): Chord | undefined {
  const key = stroke.key.toLowerCase()
  if (prefix) {
    if (key === 'f') return 'C-x f'
    if (key === 'd') return stroke.ctrlKey ? 'C-x C-d' : 'C-x d'
    // The arrow keys keep their `Arrow` name; the design writes them short.
    if (key === 'arrowright' || key === 'right') return 'C-x right'
    if (key === 'arrowdown' || key === 'down') return 'C-x down'
    return undefined
  }
  if (!stroke.altKey) return undefined
  switch (key) {
    case 'h': return 'M-h'
    case 'j': return 'M-j'
    case 'k': return 'M-k'
    case 'l': return 'M-l'
    default: return undefined
  }
}

/** What the layer knows about the moment a key arrived. */
export interface KeyContext {
  /** Whether `C-x` is already waiting for its second key. */
  readonly prefix: boolean
  /** Whether the keystroke landed in a text field. */
  readonly editing: boolean
  /** Whether that field has text selected. */
  readonly selected: boolean
}

/**
 * Decide what one keystroke means.
 *
 * The whole rule, in one place:
 *
 * 1. With the prefix already open, the next key is the chord's second key —
 *    inside a text field as much as outside it.
 * 2. Otherwise `C-x` is the browser's cut whenever there is something to cut,
 *    and opens the prefix only when the key would otherwise do nothing.
 * 3. Everything else is a bare chord, which a text field does not get to keep:
 *    `M-h` there is still the frame to the left, not a special character.
 * @param stroke - the key event, narrowed to what is read.
 * @param context - the prefix state and what the keystroke landed in.
 * @returns what to do with the event.
 */
export function decideKey(stroke: KeyStroke, context: KeyContext): KeyDecision {
  if (context.prefix) {
    const chord = readChord(stroke, true)
    return chord === undefined ? { kind: 'ignore' } : { kind: 'chord', chord }
  }
  if (stroke.ctrlKey && !stroke.altKey && stroke.key.toLowerCase() === 'x') {
    // A selection means the user meant to cut, so the browser keeps the key.
    return context.editing && context.selected ? { kind: 'ignore' } : { kind: 'arm' }
  }
  const chord = readChord(stroke, false)
  return chord === undefined ? { kind: 'ignore' } : { kind: 'chord', chord }
}
