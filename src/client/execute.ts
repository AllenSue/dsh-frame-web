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
 * against a recording stub rather than a browser. The preset intents are the one
 * part that is not synchronous, because the medium is IO; they still make exactly
 * one call each.
 *
 * It maps the gestures a renderer can produce, and no others: the tab-level ones
 * (`drop`, `placeTab`) left with the tab strip, because a shell that shows one
 * content per frame has no chip to drag. The core still answers those intents —
 * with a refusal, in its own words — for a caller that asks anyway.
 */
import type { FrameResult, FramesService } from '../../../frames/src/index.ts'
import type { FrameGesture } from './gestures.ts'

/** Whether the model accepted a gesture, or a promise of that for the IO-backed ones. */
export type Executed = boolean | Promise<boolean>

/**
 * Report a refusal; a gesture the model will not carry out is never silent.
 *
 * Silent is exactly what it was, and a user reported the symptom rather than the
 * reason: choosing something from the picker did nothing, because the tree
 * refused it (`frames/kind-mismatch`) and the refusal only ever reached the
 * console. So the caller can hand in somewhere for it to be *seen*.
 * @param result - what the model answered.
 * @param onRefused - told the refusal's own words, when there is one.
 */
function report(result: FrameResult<unknown>, onRefused?: (message: string) => void): void {
  if (result.ok) return
  console.warn(`[frames] ${result.code}: ${result.message}`)
  onRefused?.(`${result.code}: ${result.message}`)
}

/** Report a settled asynchronous intent, containing a medium that threw. */
function settle(work: Promise<FrameResult<unknown>>): Promise<boolean> {
  return work.then(
    (result) => { report(result); return result.ok },
    (error: unknown) => {
      // The medium is outside this program: a full disk or a denied origin must
      // not surface as an unhandled rejection that never mentions the layout.
      console.warn(`[frames] preset io failed: ${String(error)}`)
      return false
    },
  )
}

/**
 * Carry out one gesture.
 * @param service - the frame tree to change.
 * @param gesture - the semantic operation the user asked for.
 * @param onRefused - told a refusal's own words, so a caller with somewhere to
 *   show them does not leave the user with "nothing happened".
 * @returns whether the model accepted it.
 */
export function execute(
  service: FramesService,
  gesture: FrameGesture,
  onRefused?: (message: string) => void,
): Executed {
  let result: FrameResult<unknown>
  switch (gesture.kind) {
    case 'split':
      // No seed: the frame is made empty, so it can offer what can be made in it.
      result = service.split(gesture.paneId, undefined, gesture.axis)
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
    case 'savePreset':
      return settle(service.savePreset(gesture.name))
    case 'applyPreset':
      return settle(service.applyPreset(gesture.name))
    case 'savePresetAs':
      // The renderer asks for the name and dispatches `savePreset` instead, so
      // reaching here means a caller dropped that step. Say so rather than
      // saving under a name nobody chose.
      console.warn('[frames] a save with no name reached execute; the renderer resolves it first')
      return false
    case 'showContent':
      result = service.showContent(gesture.paneId, gesture.contentId)
      break
    case 'openContent':
      // No options: the core looks for a frame already showing it and focuses
      // that one, or makes a new frame beside the current frame. A caller that
      // needs it somewhere particular should say so with `showContent`.
      result = service.openContent(gesture.contentId)
      break
    case 'createContent':
      result = service.createContent(gesture.typeId, gesture.paneId)
      break
    case 'pickContent':
      // Likewise: the name comes from the user, so the renderer resolves this
      // into `openContent` or `createContent` before dispatching.
      console.warn('[frames] a pick with no name reached execute; the renderer resolves it first')
      return false
  }
  report(result, onRefused)
  return result.ok
}
