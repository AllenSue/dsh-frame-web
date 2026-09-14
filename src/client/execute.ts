/**
 * The one place a gesture becomes a change.
 *
 * Every key chord and every pointer release arrives here as a `FrameGesture`,
 * and each kind maps to exactly one call on the frame service. That is the whole
 * contract T08 rests on: because the mapping is total and one-to-one, a drag can
 * neither change the tree twice nor record a history entry of its own, and a
 * refusal — a policy, a budget, a pane with no room — is reported in the same
 * words whichever way the user asked for it.
 *
 * This module imports no React and touches no DOM, so the mapping is asserted
 * against a recording stub rather than a browser.
 */
import type { FramesService, FrameResult } from '../../../frames/src/index.ts'
import type { FrameGesture } from './gestures.ts'

/** Report a refusal; a gesture the model will not carry out is never silent. */
function report(result: FrameResult<unknown>): void {
  if (!result.ok) console.warn(`[frames] ${result.code}: ${result.message}`)
}

/**
 * Carry out one gesture.
 * @param service - the frame tree to change.
 * @param gesture - the semantic operation the user asked for.
 * @returns whether the model accepted it.
 */
export function execute(service: FramesService, gesture: FrameGesture): boolean {
  let result: FrameResult<unknown>
  switch (gesture.kind) {
    case 'split':
      result = service.split(gesture.paneId, gesture.seed, gesture.axis)
      break
    case 'drop':
      result = service.drop(gesture.tabId, gesture.target, gesture.seed)
      break
    case 'placeTab':
      result = service.placeTab(gesture.tabId, gesture.paneId, gesture.index)
      break
    case 'close':
      result = service.close(gesture.paneId)
      break
    case 'float':
      result = service.float(gesture.paneId)
      break
    case 'dock':
      result = service.dock(gesture.paneId)
      break
    case 'focus':
      result = service.moveFocus(gesture.direction)
      break
    case 'focusPane':
      result = service.focus(gesture.paneId)
      break
    case 'resizeSplit':
      result = service.resizeSplit(gesture.splitId, gesture.sizes)
      break
    case 'placeFloat':
      result = service.placeFloat(gesture.paneId, gesture.rect)
      break
  }
  report(result)
  return result.ok
}
