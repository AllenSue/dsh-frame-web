/**
 * The content picker's list: what it offers, what a query leaves, and what a
 * choice does.
 *
 * `C-x b` is `switch-to-buffer`, and the person using it may be thinking of
 * something the shell already holds or of a kind of thing it could make. So one
 * list carries both, grouped, and the query has to answer the question a
 * *person* is asking — they type `doc` meaning the document preview, not a
 * regular expression.
 *
 * That is why the ranking is by how a name starts rather than by where the
 * letters fall: an exact id or title first, then a prefix, then anything
 * containing it, and only last the scattered subsequence that lets `dpr` reach
 * `document-preview`. Within a rank the list keeps its own order, so Open stays
 * before New and the list does not reshuffle under the cursor.
 *
 * Nothing here knows about frames: the rows are the projection's own contents
 * and types, so this file stays a pure function over what the shell already
 * publishes and the core never learns that a picker exists.
 */
import type { PaneId } from '../../../frames/src/index.ts'
import type { FrameGesture } from './gestures.ts'

/** One row the picker can offer. */
export interface PickerChoice {
  /** Which half of the list it belongs to: what exists, or what can be made. */
  readonly group: 'open' | 'new'
  readonly id: string
  readonly title: string
}

/** What the picker lists: the parts of a projection it reads. */
export interface PickerSource {
  readonly contents: readonly { readonly id: string; readonly title: string }[]
  readonly types: readonly { readonly id: string; readonly title: string; readonly instantiable: boolean }[]
}

/** Where a row's name matched, best first. */
const RANK = { exact: 0, prefix: 1, contains: 2, scattered: 3, none: 4 } as const

/**
 * How well a name answers a query.
 *
 * Case is ignored throughout: nobody types a capital to disambiguate a list this
 * short. An empty needle matches everything equally, which is what keeps the
 * unfiltered list in its own order.
 * @param name - the id or title to test.
 * @param needle - the query, already trimmed and lowercased.
 * @returns the rank, `none` when the name does not answer it at all.
 */
function rank(name: string, needle: string): number {
  if (needle === '') return RANK.exact
  const lower = name.toLowerCase()
  if (lower === needle) return RANK.exact
  if (lower.startsWith(needle)) return RANK.prefix
  if (lower.includes(needle)) return RANK.contains
  // The scattered match: every character of the needle appears in order. It is
  // last because it is the loosest, and it is there because `dpr` reaching
  // `document-preview` is exactly the shorthand a keyboard user types.
  let at = 0
  for (const character of lower) {
    if (character === needle[at]) at += 1
    if (at === needle.length) return RANK.scattered
  }
  return RANK.none
}

/**
 * The rows the picker offers, in list order.
 * @param source - the contents and types the projection publishes.
 * @returns what the shell holds, then what can be made — only the kinds a person
 *   can actually ask for, so an uninstantiable type is not an invitation to a
 *   refusal.
 */
export function pickerChoices(source: PickerSource): readonly PickerChoice[] {
  return [
    ...source.contents.map((content): PickerChoice => ({ group: 'open', id: content.id, title: content.title })),
    ...source.types
      .filter((type) => type.instantiable)
      .map((type): PickerChoice => ({ group: 'new', id: type.id, title: type.title })),
  ]
}

/**
 * The rows a query leaves, best first.
 *
 * A row's rank is the better of its id and its title: the id is what a keyboard
 * user remembers, the title is what they read.
 * @param choices - every row, in list order.
 * @param query - what has been typed so far.
 * @returns the matching rows, ordered by rank and otherwise by list order.
 */
export function matchChoices(choices: readonly PickerChoice[], query: string): readonly PickerChoice[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return choices
  return choices
    .map((choice, index) => ({ choice, index, rank: Math.min(rank(choice.id, needle), rank(choice.title, needle)) }))
    .filter((scored) => scored.rank !== RANK.none)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((scored) => scored.choice)
}

/**
 * What choosing a row does.
 *
 * The group decides, not a guess: a row from Open names something the shell
 * holds, a row from New names a kind to make one of. That is the whole reason
 * the list carries groups rather than one flat set of names.
 *
 * **Both land in the frame the picker was opened over** — the one that had focus,
 * or the empty frame whose own list this is. "Show it here" and "make one here"
 * are what a person choosing from a list inside a frame means, and a frame now
 * displays one content, so showing one here is a swap rather than a request the
 * tree can refuse: there is no second kind to clash with, and nothing to stack.
 *
 * It briefly went through `openContent` instead, which shows a content *somewhere*
 * — focus the frame already displaying it, or make a new one beside this. That
 * reads well for a global switch and badly for this: an empty frame could never
 * be filled by its own list, because the answer always landed somewhere else.
 * @param choice - the chosen row.
 * @param paneId - the frame it lands in.
 * @returns the gesture to dispatch.
 */
export function choiceGesture(choice: PickerChoice, paneId: PaneId): FrameGesture {
  return choice.group === 'open'
    ? { kind: 'showContent', paneId, contentId: choice.id }
    : { kind: 'createContent', paneId, typeId: choice.id }
}

/** What the picker is showing: the list, the query, and where the cursor is. */
export interface PickerState {
  /** The frame a choice lands in — the one focused when it opened. */
  readonly paneId: PaneId
  readonly query: string
  /** Which visible row the cursor is on, counted over the *filtered* list. */
  readonly index: number
}

/**
 * The state a keystroke leaves, or `undefined` when the key is not the picker's.
 *
 * Movement wraps, because a list this short has no edges worth guarding, and the
 * cursor is kept inside the filtered list rather than remembered across queries:
 * a filter that shortens the list must not leave the cursor past its end.
 * @param state - the picker as it stands.
 * @param choices - the rows the current query leaves.
 * @param key - the key that was pressed.
 * @returns the next state, or `undefined` when the picker leaves it alone.
 */
export function pickerKey(
  state: PickerState,
  choices: readonly PickerChoice[],
  key: 'up' | 'down',
): PickerState {
  if (choices.length === 0) return { ...state, index: 0 }
  const step = key === 'down' ? 1 : -1
  return { ...state, index: (state.index + step + choices.length) % choices.length }
}
