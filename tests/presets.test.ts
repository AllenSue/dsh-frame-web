import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Preset } from '../../frames/src/index.ts'
import { PRESET_FORMAT_VERSION } from '../../frames/src/index.ts'
import { createPresetPort, nextStartup, PRESET_KEY_PREFIX, presetRows, readStartup, writeStartup } from '../src/client/presets.ts'
import type { PresetStorage } from '../src/client/presets.ts'

/** A `localStorage` stand-in: insertion-ordered, with the five members used. */
function storage(seed: Record<string, string> = {}): PresetStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(seed))
  return {
    entries,
    get length() { return entries.size },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) },
    removeItem: (key) => { entries.delete(key) },
  }
}

/** A preset as the core would hand one to the medium. */
function preset(name: string): Preset {
  return {
    version: PRESET_FORMAT_VERSION,
    name,
    mint: 3,
    layout: {
      nodes: {},
      tabs: {},
      rootId: 'pane1' as never,
      floats: [],
      activePaneId: 'pane1' as never,
      expanded: true,
      mode: 'push',
    },
  }
}

test('a written preset reads back exactly, and lands under the plugin namespace', async () => {
  const store = storage()
  const port = createPresetPort(store)

  await port.write('work', preset('work'))

  assert.deepEqual([...store.entries.keys()], [`${PRESET_KEY_PREFIX}work`])
  assert.deepEqual(await port.read('work'), JSON.parse(JSON.stringify(preset('work'))))
  assert.deepEqual(await port.list(), ['work'])
})

test('listing finds only this plugin\'s entries', async () => {
  const store = storage({
    'unrelated': 'x',
    [`${PRESET_KEY_PREFIX}alpha`]: '{}',
    [`${PRESET_KEY_PREFIX}beta`]: '{}',
  })
  const port = createPresetPort(store)

  assert.deepEqual([...await port.list()].sort(), ['alpha', 'beta'])
})

test('a name is an address, so a second write replaces the first', async () => {
  const store = storage()
  const port = createPresetPort(store)

  await port.write('work', preset('work'))
  await port.write('work', { ...preset('work'), mint: 9 })

  assert.deepEqual(await port.list(), ['work'])
  assert.equal((await port.read('work') as Preset).mint, 9)
})

test('removing a preset takes it out of the index too', async () => {
  const store = storage()
  const port = createPresetPort(store)
  await port.write('work', preset('work'))

  await port.remove('work')

  assert.deepEqual(await port.list(), [])
  assert.equal(await port.read('work'), undefined)
})

test('a missing preset reads as absent, not as an error', async () => {
  const port = createPresetPort(storage())

  assert.equal(await port.read('never-saved'), undefined)
  assert.deepEqual(await port.list(), [])
})

test('an entry that is not JSON reads as absent, so one bad byte is not fatal', async () => {
  const store = storage({ [`${PRESET_KEY_PREFIX}broken`]: '{not json' })
  const port = createPresetPort(store)

  // The entry stays in the index — the medium does not get to edit itself — but
  // reading it yields nothing, which the core then reports as no such preset.
  assert.deepEqual(await port.list(), ['broken'])
  assert.equal(await port.read('broken'), undefined)
})

test('a custom namespace keeps two ports out of each other\'s way', async () => {
  const store = storage()
  const first = createPresetPort(store, 'a.')
  const second = createPresetPort(store, 'b.')

  await first.write('work', preset('work'))
  await second.write('work', preset('work'))

  assert.deepEqual(await first.list(), ['work'])
  assert.deepEqual(await second.list(), ['work'])
  assert.equal(store.entries.size, 2)
})

// ------------------------------------------------- the startup preference

test('the startup preset is a name, and an empty one is no preference at all', () => {
  const store = storage()

  assert.equal(readStartup(store), undefined, 'nothing stored means no preference')
  writeStartup(store, 'work')
  assert.equal(readStartup(store), 'work')
  // Whitespace is not a name: a preference that is a space would make the shell
  // try to load a preset called " " at every boot.
  store.setItem('dsh.frames.startup', '   ')
  assert.equal(readStartup(store), undefined)

  writeStartup(store, undefined)
  assert.equal(readStartup(store), undefined, 'and clearing it is a removal')
  assert.equal(store.entries.size, 0)
})

test('the startup preference shares the medium with the presets but not their keys', async () => {
  const store = storage()
  const port = createPresetPort(store)

  writeStartup(store, 'work')
  await port.write('work', preset('work'))

  // The preference must not look like a preset to a catalog scan, or the shell
  // would offer "dsh.frames.startup" as something to load.
  assert.deepEqual(await port.list(), ['work'])
  assert.equal(readStartup(store), 'work')
})

test('a list row says which preset is in use and which one is the startup preset', () => {
  const rows = presetRows(['frontend', 'notes', 'work'], 'work', 'frontend')

  assert.deepEqual(rows, [
    { name: 'frontend', label: 'frontend  ·  startup' },
    { name: 'notes', label: 'notes' },
    { name: 'work', label: 'work  ·  in use' },
  ])
  // One preset can be both, and then it says both.
  assert.deepEqual(
    presetRows(['work'], 'work', 'work'),
    [{ name: 'work', label: 'work  ·  in use · startup' }],
  )
})

test('the startup chord is a toggle, and needs a preset in use to name one', () => {
  assert.equal(nextStartup('work', undefined), 'work', 'marking the one in use')
  assert.equal(nextStartup('work', 'work'), undefined, 'pressing it again takes the mark off')
  assert.equal(nextStartup('work', 'other'), 'work', 'marking a different one moves the mark')
  assert.equal(nextStartup(undefined, 'work'), undefined, 'with no preset in use there is nothing to mark')
})
