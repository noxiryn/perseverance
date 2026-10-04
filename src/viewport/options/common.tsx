import { Square, SquaresIntersect, SquaresSubtract, SquaresUnite } from 'lucide-react';
import { IconButton } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import type { SelectionMode } from '../../editor/selection';
import '../viewport.css';

export function setToolOptionSafe(toolId: string, key: string, value: unknown) {
  useEditor.getState().setToolOption(toolId, key, value);
}

const MODES: { value: SelectionMode; icon: typeof Square; title: string }[] = [
  { value: 'new', icon: Square, title: 'New selection' },
  { value: 'add', icon: SquaresUnite, title: 'Add to selection (Shift)' },
  { value: 'subtract', icon: SquaresSubtract, title: 'Subtract from selection (Alt)' },
  { value: 'intersect', icon: SquaresIntersect, title: 'Intersect with selection (Shift+Alt)' },
];

/** New / Add / Subtract / Intersect segmented buttons. */
export function SelectionModeButtons({ toolId, value }: { toolId: string; value: SelectionMode }) {
  return (
    <div className="viewport-seg" role="radiogroup" aria-label="Selection mode">
      {MODES.map((m) => (
        <IconButton
          key={m.value}
          icon={m.icon}
          size="sm"
          iconSize={14}
          active={value === m.value}
          title={m.title}
          onClick={() => setToolOptionSafe(toolId, 'mode', m.value)}
        />
      ))}
    </div>
  );
}

export function Sep() {
  return <span className="viewport-opts-sep" />;
}

export function Label({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="viewport-opts-label" title={title}>
      {children}
    </span>
  );
}
