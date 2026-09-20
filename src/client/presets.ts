/**
 * The browser's preset medium.
 *
 * One `localStorage` entry per preset, keyed by name. `per-record` rather than
 * one blob, because that is what the records are — written, read, and deleted
 * one at a time — and because a single blob puts every preset behind whichever
 * one fails to parse.
 *
 * `localStorage` is the client's established medium here: `@deepseek-ai/dsh-client-store`
 * and `ui-conversation` both persist through it. There is no client-side
 * storage-domain API, so a preset that a terminal or another browser should also
 * see would need a host-side port; this is the one the web renderer can have.
 */
import type { Preset, PresetPort } from '../../../frames/src/index.ts'

/** Namespace for this plugin's entries, so a scan finds only its own. */
export const PRESET_KEY_PREFIX = 'dsh.frames.preset.'

/**
 * The storage this port writes through.
 *
 * Narrowed to the five members actually used, so a test can pass a map without
 * pretending to be a browser.
 */
export interface PresetStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Build a port over a storage medium.
 * @param storage - the medium; `window.localStorage` satisfies it.
 * @param prefix - entry namespace; defaults to this plugin's.
 * @returns the port the frame service reads and writes presets through.
 */
export function createPresetPort(
  storage: PresetStorage,
  prefix: string = PRESET_KEY_PREFIX,
): PresetPort {
  return {
    async list(): Promise<readonly string[]> {
      const names: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key !== null && key.startsWith(prefix)) names.push(key.slice(prefix.length))
      }
      return names
    },

    async read(name: string): Promise<unknown> {
      const raw = storage.getItem(`${prefix}${name}`)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw) as unknown
      } catch {
        // An entry that is not JSON reads as absent. The alternative — letting
        // the throw out — would take the whole shell down at mount because one
        // stored byte went bad, and there is nothing here that could repair it.
        return undefined
      }
    },

    async write(name: string, preset: Preset): Promise<void> {
      storage.setItem(`${prefix}${name}`, JSON.stringify(preset))
    },

    async remove(name: string): Promise<void> {
      storage.removeItem(`${prefix}${name}`)
    },
  }
}

/** Where "load this one when the shell starts" is kept. One name, one entry. */
export const STARTUP_KEY = 'dsh.frames.startup'

/**
 * The preset this shell should open on, if the user has named one.
 *
 * A preference of its own rather than a flag inside a preset: it says which record
 * to *read* at boot, so it has to be readable without reading any of them — and a
 * name that no longer exists is the same as no preference at all (the shell then
 * opens the way a shell with no presets does, instead of failing to start).
 * @param storage - the medium.
 * @param key - the entry; defaults to this plugin's.
 * @returns the preset's name, or `undefined` when there is none.
 */
export function readStartup(storage: PresetStorage, key: string = STARTUP_KEY): string | undefined {
  const raw = storage.getItem(key)
  const name = raw === null ? '' : raw.trim()
  return name === '' ? undefined : name
}

/**
 * Remember which preset to open on, or forget it.
 * @param storage - the medium.
 * @param name - the preset's name; `undefined` clears the preference.
 * @param key - the entry; defaults to this plugin's.
 */
export function writeStartup(storage: PresetStorage, name: string | undefined, key: string = STARTUP_KEY): void {
  if (name === undefined) storage.removeItem(key)
  else storage.setItem(key, name)
}

/** One row of the preset list, as the dialog draws it. */
export interface PresetRow {
  readonly name: string
  /** What the row says: the name, with what it is marked as. */
  readonly label: string
}

/**
 * The rows the preset dialog offers, in the order the catalog holds them.
 *
 * The marks are the whole reason this is a function and not a map: `C-x s` cycles
 * blind, so a list that did not say which preset is **in use** and which one is
 * the **startup** one would leave the user setting a preference with no feedback.
 * @param names - the catalog, in name order.
 * @param active - the preset in force, if any.
 * @param startup - the preset the shell opens on, if any.
 * @returns one row per preset.
 */
export function presetRows(
  names: readonly string[],
  active: string | undefined,
  startup: string | undefined,
): readonly PresetRow[] {
  return names.map((name) => {
    const marks = [
      name === active ? 'in use' : undefined,
      name === startup ? 'startup' : undefined,
    ].filter((mark): mark is string => mark !== undefined)
    return { name, label: marks.length === 0 ? name : `${name}  ·  ${marks.join(' · ')}` }
  })
}

/**
 * What `C-x C-p` should store.
 *
 * A toggle rather than "set": the same chord has to be able to undo itself, since
 * the key map has no other way to say "do not load anything at startup".
 * @param active - the preset in force, if any. Without one there is nothing to mark.
 * @param startup - the preset currently marked, if any.
 * @returns the name to store, or `undefined` to clear the preference.
 */
export function nextStartup(active: string | undefined, startup: string | undefined): string | undefined {
  if (active === undefined) return undefined
  return active === startup ? undefined : active
}
