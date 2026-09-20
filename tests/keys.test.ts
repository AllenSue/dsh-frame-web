import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideKey, hasSelection, isEditing, readChord } from '../src/client/keys.ts'
import type { Chord, KeyContext, KeyStroke, TypingTarget } from '../src/client/keys.ts'

/** A keystroke as the browser would report it. */
function stroke(key: string, modifiers: { ctrl?: boolean; alt?: boolean } = {}): KeyStroke {
  return { key, ctrlKey: modifiers.ctrl === true, altKey: modifiers.alt === true }
}

/** Outside any text field. */
const PAGE: TypingTarget = { tagName: 'DIV', isContentEditable: false }

const KEY: KeyContext = { prefix: false, editing: false, selected: false }

test('a text field is recognised, and so is a rich editor', () => {
  assert.equal(isEditing({ tagName: 'INPUT' }), true)
  assert.equal(isEditing({ tagName: 'TEXTAREA' }), true)
  assert.equal(isEditing({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditing(PAGE), false)
  assert.equal(isEditing(null), false)
  assert.equal(isEditing(undefined), false)
})

test('a selection is read from offsets, or from the document for a rich editor', () => {
  assert.equal(hasSelection({ tagName: 'TEXTAREA', selectionStart: 0, selectionEnd: 4 }, true), true)
  assert.equal(hasSelection({ tagName: 'TEXTAREA', selectionStart: 4, selectionEnd: 4 }, false), false)
  // A rich editor reports no offsets, so the caller's document reading decides.
  assert.equal(hasSelection({ tagName: 'DIV', isContentEditable: true }, false), true)
  assert.equal(hasSelection({ tagName: 'DIV', isContentEditable: true }, true), false)
})

test('the chords the design binds are the chords that read back', () => {
  // Keyed by chord so a rename on either side breaks this test rather than
  // silently dropping a binding.
  const expected: Readonly<Record<Chord, [KeyStroke, boolean]>> = {
    'C-x down': [stroke('ArrowDown', { ctrl: true }), true],
    'C-x right': [stroke('ArrowRight', { ctrl: true }), true],
    'C-x f': [stroke('f', { ctrl: true }), true],
    'C-x d': [stroke('d'), true],
    'C-x C-d': [stroke('d', { ctrl: true }), true],
    'C-x s': [stroke('s'), true],
    'C-x C-s': [stroke('s', { ctrl: true }), true],
    'C-x p': [stroke('p'), true],
    'C-x C-p': [stroke('p', { ctrl: true }), true],
    'C-x b': [stroke('b'), true],
    'M-h': [stroke('h', { alt: true }), false],
    'M-j': [stroke('j', { alt: true }), false],
    'M-k': [stroke('k', { alt: true }), false],
    'M-l': [stroke('l', { alt: true }), false],
  }
  for (const [chord, [keys, prefix]] of Object.entries(expected) as [Chord, [KeyStroke, boolean]][]) {
    assert.equal(readChord(keys, prefix), chord, `${chord} does not read back`)
  }
})

test('an unbound key is not a chord and is left alone', () => {
  assert.equal(readChord(stroke('q'), false), undefined)
  assert.equal(readChord(stroke('q', { alt: true }), false), undefined)
  assert.equal(readChord(stroke('z'), true), undefined)
  assert.equal(readChord(stroke('h', { alt: true }), true), undefined, 'the prefix map is its own')
  assert.deepEqual(decideKey(stroke('a'), KEY), { kind: 'ignore' })
  assert.deepEqual(decideKey(stroke('a', { ctrl: true }), KEY), { kind: 'ignore' })
})

test('C-x opens the prefix wherever the key would otherwise do nothing', () => {
  // Outside a field, and inside one with the caret sitting still.
  assert.deepEqual(decideKey(stroke('x', { ctrl: true }), KEY), { kind: 'arm' })
  assert.deepEqual(
    decideKey(stroke('x', { ctrl: true }), { prefix: false, editing: true, selected: false }),
    { kind: 'arm' },
  )
})

test('C-x with a selection stays the browser\'s cut, inside a text field', () => {
  const selected = { prefix: false, editing: true, selected: true }
  assert.deepEqual(decideKey(stroke('x', { ctrl: true }), selected), { kind: 'ignore' })
  // The selection only means "cut" where there is something that can be cut.
  assert.deepEqual(decideKey(stroke('x', { ctrl: true }), { ...selected, editing: false }), { kind: 'arm' })
})

test('a chord fires inside a text field, which is the point of the rule', () => {
  const editing: KeyContext = { prefix: false, editing: true, selected: false }
  assert.deepEqual(decideKey(stroke('h', { alt: true }), editing), { kind: 'chord', chord: 'M-h' })
  assert.deepEqual(decideKey(stroke('l', { alt: true }), editing), { kind: 'chord', chord: 'M-l' })
  // And the prefix's second key too, with or without a selection.
  assert.deepEqual(
    decideKey(stroke('f'), { prefix: true, editing: true, selected: false }),
    { kind: 'chord', chord: 'C-x f' },
  )
  assert.deepEqual(
    decideKey(stroke('f'), { prefix: true, editing: true, selected: true }),
    { kind: 'chord', chord: 'C-x f' },
  )
})

test('the prefix survives exactly one keystroke, bound or not', () => {
  // An unbound second key is ignored, and the caller clears the prefix either
  // way — an accidental `C-x` must not swallow everything typed after it.
  assert.deepEqual(decideKey(stroke('z'), { prefix: true, editing: true, selected: false }), { kind: 'ignore' })
  assert.deepEqual(decideKey(stroke('Escape'), { prefix: true, editing: false, selected: false }), { kind: 'ignore' })
})
