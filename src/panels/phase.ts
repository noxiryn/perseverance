/** How panel edits reach the history (pure helpers, re-exported by layerOps). */
import type { ParamDef } from '../core/types';

/**
 * How an edit reaches the document:
 *  - 'preview'  — live change without a history step (call on every move of a drag);
 *  - 'commit'   — one discrete history step (buttons, toggles, selects, menu commands);
 *  - 'coalesce' — a history step that merges into the previous one when it has the same label and
 *                 is < 1 s old. Only for the END of continuous controls (slider / scrub release,
 *                 typed values, arrow-key nudges), so a burst of small adjustments is one step.
 */
export type Phase = 'preview' | 'commit' | 'coalesce';

/**
 * Phase for the onCommit of a generated ParamEditor control: continuous controls (sliders,
 * angles, colors, gradients, curves, points, text, seeds) coalesce; discrete ones (checkboxes,
 * selects, fonts) are their own history step.
 */
export function paramCommitPhase(defs: readonly ParamDef[] | undefined, key: string): Phase {
  const t = defs?.find((d) => d.key === key)?.type;
  return t === 'boolean' || t === 'select' || t === 'font' ? 'commit' : 'coalesce';
}

/** History label for a ParamEditor edit, e.g. "Stroke Size" — distinct per parameter. */
export function paramLabel(prefix: string, defs: readonly ParamDef[] | undefined, key: string): string {
  const d = defs?.find((x) => x.key === key);
  return d?.label ? `${prefix} ${d.label}` : prefix;
}
