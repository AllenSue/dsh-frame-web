import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FramesService } from '../../frames/src/index.ts'
import { fail, ok } from '../../frames/src/index.ts'
import {
  chordGesture, dividerDelta, draggedFloatRect, dragSizes, nextPreset, resizedFloatRect,
} from '../src/client/gestures.ts'
import type { Chord, FrameGesture, GestureContext } from '../src/client/gestures.ts'
import { execute } from '../src/client/execute.ts'

/**
 * What a chord reads.
 *
 * It is small because the layer stopped having a tab strip: no focused chip, no
 * pane list to drop onto. What is left is the frame a chord acts on and the
 * preset catalog it switches through.
 */
const CONTEXT: GestureContext = {
  activePaneId: 'pane-1' as GestureContext['activePaneId'],
  presets: [],
  activePreset: undefined,
}

/** A service that records the calls it receives and accepts every one of them. */
function recorder(): { service: FramesService; calls: readonly unknown[][] } {
  const calls: unknown[][] = []
  const note = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args])
    return ok(undefined)
  }
  /** The preset intents answer later, because their medium does. */
  const later = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args])
    return Promise.resolve(ok(undefined))
  }
  const service = {
    registerType: note('registerType'),
    attachRenderer: note('attachRenderer'),
    reportMeasurements: note('reportMeasurements'),
    project: () => { throw new Error('the gesture layer must not read the projection') },
    subscribe: note('subscribe'),
    split: note('split'),
    close: note('close'),
    float: note('float'),
    dock: note('dock'),
    focus: note('focus'),
    moveFocus: note('moveFocus'),
    open: note('open'),
    drop: note('drop'),
    placeTab: note('placeTab'),
    resizeSplit: note('resizeSplit'),
    placeFloat: note('placeFloat'),
    activeTypeId: () => undefined,
    isOpen: () => false,
    activePresetId: () => undefined,
    presetNames: () => [],
    contents: () => [],
    content: () => undefined,
    refreshPresets: later('refreshPresets'),
    savePreset: later('savePreset'),
    applyPreset: later('applyPreset'),
    showContent: note('showContent'),
    openContent: note('openContent'),
    createContent: note('createContent'),
    paneKind: () => undefined,
  } as unknown as FramesService
  return { service, calls }
}

test('every bound chord names an operation, and an unbound one names nothing', () => {
  // `C-x s` is deliberately absent: it needs a catalog to cycle, and has its own
  // test below with one.
  const bound: readonly Chord[] = [
    'C-x down', 'C-x right', 'C-x f', 'C-x d', 'C-x C-d', 'C-x C-s', 'C-x b',
    'M-h', 'M-j', 'M-k', 'M-l',
  ]
  for (const chord of bound) {
    const gesture = chordGesture(chord, CONTEXT)
    assert.notEqual(gesture, undefined, `${chord} should be bound`)
  }
  assert.equal(chordGesture('C-x C-d', CONTEXT)?.kind, 'close')
  assert.equal(chordGesture('C-x f', CONTEXT)?.kind, 'float')
  assert.equal(chordGesture('C-x d', CONTEXT)?.kind, 'dock')
  // The two splits are the only ones the key map offers, and they differ by axis.
  // Neither carries a seed: a new frame starts empty and offers what can be made.
  assert.deepEqual(chordGesture('C-x right', CONTEXT), {
    kind: 'split', paneId: 'pane-1', axis: 'row',
  })
  assert.deepEqual(chordGesture('C-x down', CONTEXT), {
    kind: 'split', paneId: 'pane-1', axis: 'column',
  })
})

test('a chord with nothing focused refuses to name a target', () => {
  const idle: GestureContext = { ...CONTEXT, activePaneId: undefined }

  assert.equal(chordGesture('C-x right', idle), undefined)
  assert.equal(chordGesture('C-x f', idle), undefined)
  // Focus movement needs no target, so it still works with nothing focused.
  assert.deepEqual(chordGesture('M-h', idle), { kind: 'focus', direction: 'left' })
})

test('a divider drag moves only the two children it separates', () => {
  const divider = {
    splitId: 'split-1' as never,
    axis: 'row' as const,
    index: 0,
    sizes: [0.5, 0.3, 0.2],
    parent: { x: 0, y: 0, width: 1, height: 1 },
  }

  const next = dragSizes(divider, 0.1)
  assert.ok(Math.abs((next[0] ?? 0) - 0.6) < 1e-9)
  assert.ok(Math.abs((next[1] ?? 0) - 0.2) < 1e-9)
  assert.ok(Math.abs((next[2] ?? 0) - 0.2) < 1e-9, 'the third child does not move')
  assert.ok(Math.abs(next.reduce((sum, size) => sum + size, 0) - 1) < 1e-9, 'the split keeps its total')
})

test('a divider drag is stopped by the pane floor', () => {
  const divider = {
    splitId: 'split-1' as never,
    axis: 'row' as const,
    index: 0,
    sizes: [0.5, 0.5],
    parent: { x: 0, y: 0, width: 1, height: 1 },
  }
  const next = dragSizes(divider, 0.49)

  assert.ok((next[0] ?? 0) < 0.95, 'the drag cannot swallow the neighbour')
  assert.ok((next[1] ?? 0) >= 0.12, 'the neighbour keeps the engine floor')
})

test('a divider drag never indexes past the children it has', () => {
  const divider = {
    splitId: 'split-1' as never,
    axis: 'row' as const,
    index: 3,
    sizes: [0.5, 0.5],
    parent: { x: 0, y: 0, width: 1, height: 1 },
  }
  assert.deepEqual(dragSizes(divider, 0.1), [0.5, 0.5])
})

test('pixel movement becomes a share of the split, not of the window', () => {
  const divider = {
    splitId: 'split-1' as never,
    axis: 'row' as const,
    index: 0,
    sizes: [0.5, 0.5],
    parent: { x: 0.5, y: 0, width: 0.5, height: 1 },
  }
  // 100px across a 1000px window is a tenth of the window, and a fifth of the
  // half-width split it lands in.
  assert.ok(Math.abs(dividerDelta(divider, { x: 100, y: 0 }, { width: 1000, height: 800 }) - 0.2) < 1e-9)
  // A drag across a split that is not there cannot divide by it.
  const flat = { ...divider, parent: { x: 0, y: 0, width: 0, height: 0 } }
  assert.equal(dividerDelta(flat, { x: 100, y: 0 }, { width: 1000, height: 800 }), 0)
})

test('dragging a floating frame moves it and keeps it on screen', () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.5 }

  assert.deepEqual(draggedFloatRect(start, { x: 0.1, y: 0.1 }), { x: 0.30000000000000004, y: 0.30000000000000004, width: 0.4, height: 0.5 })
  const pushed = draggedFloatRect(start, { x: 9, y: 9 })
  assert.ok(pushed.x + pushed.width <= 1.0001)
  assert.ok(pushed.y + pushed.height <= 1.0001)
})

test('resizing from a corner keeps the opposite corner where it was', () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }

  const grown = resizedFloatRect(start, { x: 0.1, y: 0.1 }, 'se')
  assert.deepEqual(grown, { x: 0.2, y: 0.2, width: 0.5, height: 0.5 })

  // Growing from the north-west moves the origin and leaves the far corner.
  const fromNorthWest = resizedFloatRect(start, { x: -0.1, y: -0.1 }, 'nw')
  assert.ok(Math.abs(fromNorthWest.x - 0.1) < 1e-9)
  assert.ok(Math.abs(fromNorthWest.x + fromNorthWest.width - 0.6) < 1e-9)
})

test('a resize cannot shrink a floating frame away, nor push it off screen', () => {
  const start = { x: 0.5, y: 0.5, width: 0.4, height: 0.4 }

  const tiny = resizedFloatRect(start, { x: -9, y: -9 }, 'se')
  assert.ok(tiny.width >= 0.15 && tiny.height >= 0.15)
  assert.ok(tiny.x >= 0 && tiny.y >= 0)

  // Shrinking from the north-west past the far edge leaves the origin clamped.
  const wide = resizedFloatRect(start, { x: 9, y: 9 }, 'nw')
  assert.ok(wide.x >= 0 && wide.y >= 0)
  assert.ok(wide.x + wide.width <= 1.0001)
})

test('switching preset walks the catalog and wraps', () => {
  assert.equal(nextPreset(['a', 'b', 'c'], 'a'), 'b')
  assert.equal(nextPreset(['a', 'b', 'c'], 'c'), 'a', 'the last one wraps to the first')
  // A layout that is on no preset, or on one since deleted, starts at the top.
  assert.equal(nextPreset(['a', 'b'], undefined), 'a')
  assert.equal(nextPreset(['a', 'b'], 'gone'), 'a')
  assert.equal(nextPreset([], undefined), undefined)
})

test('the preset chords name what they act on, and refuse when there is nothing to act on', () => {
  const withPresets: GestureContext = { ...CONTEXT, presets: ['a', 'b'], activePreset: 'a' }

  assert.deepEqual(chordGesture('C-x s', withPresets), { kind: 'applyPreset', name: 'b' })
  assert.equal(chordGesture('C-x C-s', withPresets)?.kind, 'savePresetAs')
  // Saving needs no target and no catalog, so it works on a shell with none.
  assert.equal(chordGesture('C-x C-s', CONTEXT)?.kind, 'savePresetAs')
  // Switching does: with an empty catalog there is nowhere to go, so the chord
  // is inert rather than an error.
  assert.equal(chordGesture('C-x s', CONTEXT), undefined)
})

test('the content chord asks, and the asking is the picker\u2019s business', () => {
  // What the chord produces is the *ask*: resolving it is the renderer's, and
  // `picker.test.ts` owns the list and its query. Nothing here may turn it into
  // an operation — `execute` has to keep seeing it as unfinished.
  assert.deepEqual(chordGesture('C-x b', CONTEXT), { kind: 'pickContent' })
})

test('a pick with no name never reaches the model', () => {
  const { service, calls } = recorder()

  assert.equal(execute(service, { kind: 'pickContent' }), false)
  assert.deepEqual(calls, [])
})

test('one gesture is one call on the frame service', async () => {
  const cases: readonly (readonly [FrameGesture, readonly unknown[]])[] = [
    // A key split makes an *empty* frame, so the new one offers what can be made
    // in it rather than copying the frame beside it.
    [{ kind: 'split', paneId: 'pane-1' as never, axis: 'row' },
      ['split', 'pane-1', undefined, 'row']],
    [{ kind: 'close', paneId: 'pane-1' as never }, ['close', 'pane-1']],
    [{ kind: 'float', paneId: 'pane-1' as never }, ['float', 'pane-1']],
    [{ kind: 'dock', paneId: 'pane-1' as never }, ['dock', 'pane-1']],
    [{ kind: 'focus', direction: 'up' }, ['moveFocus', 'up']],
    [{ kind: 'focusPane', paneId: 'pane-2' as never }, ['focus', 'pane-2']],
    [{ kind: 'resizeSplit', splitId: 'split-1' as never, sizes: [0.4, 0.6] },
      ['resizeSplit', 'split-1', [0.4, 0.6]]],
    [{ kind: 'placeFloat', paneId: 'pane-1' as never, rect: { x: 0, y: 0, width: 0.2, height: 0.2 } },
      ['placeFloat', 'pane-1', { x: 0, y: 0, width: 0.2, height: 0.2 }]],
    // The IO-backed two are still one call; they just answer later.
    [{ kind: 'savePreset', name: 'work' }, ['savePreset', 'work']],
    [{ kind: 'applyPreset', name: 'work' }, ['applyPreset', 'work']],
    [{ kind: 'showContent', paneId: 'pane-1' as never, contentId: 'file-a' },
      ['showContent', 'pane-1', 'file-a']],
    // Both halves of `C-x b`'s answer land in the frame the list was opened over.
    [{ kind: 'createContent', typeId: 'editor', paneId: 'pane-1' as never },
      ['createContent', 'editor', 'pane-1']],
  ]

  for (const [gesture, expected] of cases) {
    const { service, calls } = recorder()
    assert.equal(await Promise.resolve(execute(service, gesture)), true)
    assert.deepEqual(calls, [expected], `${gesture.kind} should make exactly one call`)
  }
})

test('a refusal is handed to whoever can put it in front of the user', () => {
  // It used to reach the console and nowhere else, which is how "choosing a row
  // does nothing" became a bug report instead of a message on the screen.
  const { service } = recorder()
  const refusing = {
    ...service,
    showContent: () => fail('frames/unknown-content', 'no content "file-a" is registered'),
  } as unknown as FramesService
  const seen: string[] = []
  const swap = { kind: 'showContent', paneId: 'pane-1' as never, contentId: 'file-a' } as const

  assert.equal(execute(refusing, swap, (message) => { seen.push(message) }), false)
  assert.deepEqual(seen, ['frames/unknown-content: no content "file-a" is registered'])

  // An accepted gesture says nothing: there is nothing to explain.
  const accepted: string[] = []
  assert.equal(execute(service, swap, (message) => { accepted.push(message) }), true)
  assert.deepEqual(accepted, [])
})

test('a save with no name never reaches the model under a guessed one', () => {
  const { service, calls } = recorder()

  // The renderer resolves `savePresetAs` before dispatch; if it does not, the
  // gesture is reported rather than saved under a name nobody chose.
  assert.equal(execute(service, { kind: 'savePresetAs' }), false)
  assert.deepEqual(calls, [])
})

test('a medium that throws is reported, not left as an unhandled rejection', async () => {
  const { service } = recorder()
  const hostile = {
    ...service,
    applyPreset: () => Promise.reject(new Error('the disk is full')),
  } as FramesService

  assert.equal(await Promise.resolve(execute(hostile, { kind: 'applyPreset', name: 'work' })), false)
})

test('every chord the layer binds is one the service can carry out', async () => {
  const { service, calls } = recorder()
  const chords: readonly Chord[] = [
    'C-x down', 'C-x right', 'C-x f', 'C-x d', 'C-x C-d', 'C-x s', 'C-x C-s',
    'M-h', 'M-j', 'M-k', 'M-l',
  ]
  for (const chord of chords) {
    const gesture = chordGesture(chord, { ...CONTEXT, presets: ['work'] })
    assert.notEqual(gesture, undefined, `${chord} should name a gesture`)
    // `savePresetAs` is the renderer's to finish; every other chord goes straight out.
    if (gesture?.kind !== 'savePresetAs') await Promise.resolve(execute(service, gesture!))
  }

  // `C-x C-s` is the one chord that does not become a service call here.
  assert.equal(calls.length, chords.length - 1)
})
