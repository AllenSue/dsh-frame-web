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
