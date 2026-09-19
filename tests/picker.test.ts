/**
 * The picker's list: what it offers, what a query leaves, and what a choice does.
 *
 * The rules under test are the ones a person feels: that typing two letters puts
 * the thing they meant on top, that the list does not reshuffle under the
 * cursor, and that choosing a row does the one thing that row can mean.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { choiceGesture, matchChoices, pickerChoices, pickerKey } from '../src/client/picker.ts'
import type { PickerChoice, PickerSource, PickerState } from '../src/client/picker.ts'

/** What a shell might hold: two contents, and a type that cannot be made. */
const SOURCE: PickerSource = {
  contents: [
    { id: 'notes-7', title: 'Notes' },
    { id: 'doc:readme.md', title: 'readme.md' },
  ],
  types: [
    { id: 'legacy.conversation', title: 'Conversation', instantiable: false },
    { id: 'editor', title: 'Editor', instantiable: true },
  ],
}

/** A picker open on a pane, with nothing typed. */
const OPEN: PickerState = { paneId: 'pane1' as PickerState['paneId'], query: '', index: 0 }

test('the list offers what the shell holds and what can be made, in that order', () => {
  const choices = pickerChoices(SOURCE)

  assert.deepEqual(choices, [
    { group: 'open', id: 'notes-7', title: 'Notes' },
    { group: 'open', id: 'doc:readme.md', title: 'readme.md' },
    // A type that declares no factory is not offered: the list would be an
    // invitation to a refusal.
    { group: 'new', id: 'editor', title: 'Editor' },
  ])
})

test('an empty query keeps every row in its own order', () => {
  const choices = pickerChoices(SOURCE)

  assert.deepEqual(matchChoices(choices, ''), choices)
  assert.deepEqual(matchChoices(choices, '   '), choices, 'whitespace is not a query')
})

test('a query ranks an exact name, then a prefix, then anything containing it', () => {
  const choices: readonly PickerChoice[] = [
    { group: 'open', id: 'panel', title: 'The panel' },
    { group: 'open', id: 'doc-panel', title: 'Document panel' },
    { group: 'new', id: 'p', title: 'Panel maker' },
  ]

  // `p` *is* the third row's id, so that row is exact and wins; `panel` prefixes
  // it, and `doc-panel` only contains it.
  assert.deepEqual(matchChoices(choices, 'p').map((choice) => choice.id), ['p', 'panel', 'doc-panel'])
  // An exact title wins outright, and a title is matched as well as an id.
  assert.deepEqual(matchChoices(choices, 'The panel').map((choice) => choice.id), ['panel'])
  assert.deepEqual(matchChoices(choices, 'document panel').map((choice) => choice.id), ['doc-panel'])
})

test('a scattered match is last, and is what makes shorthand work', () => {
  const choices = pickerChoices({
    contents: [{ id: 'document-preview', title: 'Document preview' }],
    types: [{ id: 'editor', title: 'Editor', instantiable: true }],
  })

  // `dpr` reaches `document-preview` — no prefix or substring would.
  assert.deepEqual(matchChoices(choices, 'dpr').map((choice) => choice.id), ['document-preview'])
  // Case is ignored.
  assert.deepEqual(matchChoices(choices, 'DOCU').map((choice) => choice.id), ['document-preview'])
  // And a substring beats a scattered match: `doc` is inside the title, while
  // `dpr` only scatters through it.
  assert.deepEqual(matchChoices(choices, 'doc').map((choice) => choice.id), ['document-preview'])
  assert.deepEqual(matchChoices(choices, 'ed').map((choice) => choice.id), ['editor'])
})

test('a query that answers to nothing leaves nothing, rather than everything', () => {
  const choices = pickerChoices(SOURCE)

  assert.deepEqual(matchChoices(choices, 'zzz'), [])
})

test('a row means what its group says it means', () => {
  const pane = 'pane9' as PickerState['paneId']

  // Open *shows* the content: no pane is named, because a pane holds one kind
  // and the tree is the side that decides where this one can be displayed. This
  // is the difference from the frame's own picker, which says "show it here".
  assert.deepEqual(
    choiceGesture({ group: 'open', id: 'notes-7', title: 'Notes' }, pane),
    { kind: 'openContent', contentId: 'notes-7' },
  )
  assert.deepEqual(
    choiceGesture({ group: 'new', id: 'editor', title: 'Editor' }, pane),
    { kind: 'createContent', paneId: pane, typeId: 'editor' },
  )
})

test('the cursor moves, wraps, and never leaves the list it is on', () => {
  const choices = pickerChoices(SOURCE)

  assert.equal(pickerKey(OPEN, choices, 'down').index, 1)
  assert.equal(pickerKey(OPEN, choices, 'up').index, choices.length - 1, 'up from the top wraps')
  assert.equal(pickerKey({ ...OPEN, index: choices.length - 1 }, choices, 'down').index, 0)

  const filtered = matchChoices(choices, 'notes')
  assert.equal(filtered.length, 1)
  assert.equal(
    pickerKey({ ...OPEN, index: 7 }, filtered, 'down').index,
    0,
    'a filter that shortens the list cannot leave the cursor past its end',
  )
  assert.equal(pickerKey(OPEN, [], 'down').index, 0, 'an empty list has nowhere to move')
})
