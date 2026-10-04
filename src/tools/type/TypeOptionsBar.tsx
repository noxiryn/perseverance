/** Options bar of the Type tool: font, style, size, alignment, color, warp, Character panel, commit/cancel. */
import { Check, PanelRight, Spline, X } from 'lucide-react';
import { IconButton } from '../../ui/controls';
import { useUI } from '../../state/ui';
import { useActiveDoc } from '../../state/editor';
import { AlignButtons, FontFamilyField, FontSizeField, TextFillChip, WeightStyleSelect } from './controls';
import { useTextView } from './actions';
import { cancelEditing, commitEditing, useTypeEditing } from './session';
import { openWarpDialog } from './WarpDialog';
import { getTextStyle } from './styles';
import { useTypeOptions } from './options';
import { isCharacterPanelOpen } from './panelState';
import './type.css';

export function TypeOptionsBar() {
  const editing = useTypeEditing((s) => s.layerId);
  const isNew = useTypeEditing((s) => s.isNew);
  const doc = useActiveDoc();
  const { layer } = useTextView();
  const opts = useTypeOptions();
  const panelOpen = useUI((s) => isCharacterPanelOpen(s));
  const preset = getTextStyle(opts.stylePreset);
  const warped = !!layer && layer.text.warp.style !== 'none';

  return (
    <div className="type-opts">
      <FontFamilyField width={168} />
      <WeightStyleSelect width={112} />
      <FontSizeField width={62} />
      <span className="type-opts-sep" />
      <AlignButtons />
      <span className="type-opts-sep" />
      <TextFillChip />
      <IconButton icon={Spline} title="Warp Text…" active={warped} onClick={openWarpDialog} />
      <IconButton icon={PanelRight} title="Toggle Character panel" active={panelOpen} onClick={() => useUI.getState().togglePanel('character')} />
      <span className="type-opts-spacer" />
      {editing ? (
        <>
          <span className="type-opts-hint">{isNew ? 'Typing new text' : 'Editing text'} · Ctrl+Enter commits · Esc cancels</span>
          <IconButton icon={X} title="Cancel current edits (Esc)" className="type-opts-cancel" onClick={cancelEditing} />
          <IconButton icon={Check} title="Commit current edits (Ctrl+Enter)" className="type-opts-commit" onClick={commitEditing} />
        </>
      ) : (
        <span className="type-opts-hint">
          {preset && !layer ? `Style: ${preset.name} · ` : ''}
          {!doc ? 'Open a document to add text' : layer ? `“${layer.name}” — click the text to edit it` : 'Click to add text · drag for a paragraph box'}
        </span>
      )}
    </div>
  );
}
