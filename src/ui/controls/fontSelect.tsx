/**
 * Font family picker. Props are a stable contract ({ value, onChange, width }).
 * The button shows the current family in its own face; the popover (owned by the fonts module)
 * offers search, category chips, favorites, recents, system/user fonts and a virtualized list
 * rendering every family in its face.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fonts, useRegistry } from '../../registry';
import { ensureFont } from '../../fonts/loader';
import { FontPicker, fontCss } from '../../fonts/FontPicker';
import { previewWeight } from '../../fonts/search';
import { maybeLoadSystemFonts, useSystemFonts } from '../../fonts/system';
import { Popover } from './popover';

export function FontSelect({
  value,
  onChange,
  width = '100%',
}: {
  value: string;
  onChange: (family: string) => void;
  width?: number | string;
}) {
  const list = useRegistry(fonts);
  const sys = useSystemFonts((s) => s.status);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const def = list.find((f) => f.family === value);
  const weight = previewWeight(def);
  // Unknown family: only flag it once system fonts had a chance to register.
  const missing = !def && !!value && sys !== 'idle' && sys !== 'loading';

  useEffect(() => {
    if (value) void ensureFont(value, weight);
  }, [value, weight]);

  const close = useCallback(() => setAnchor(null), []);

  return (
    <>
      <button
        type="button"
        className="ui-select fc-fontselect"
        style={{ width }}
        title={missing ? `${value} is not installed — text renders with a fallback font` : value}
        onClick={(e) => {
          if (anchor) return setAnchor(null);
          maybeLoadSystemFonts();
          setAnchor(e.currentTarget);
        }}
      >
        {missing && <AlertTriangle size={11} className="fc-fontselect-warn" />}
        <span style={{ fontFamily: fontCss({ family: value || 'sans-serif' }), fontWeight: weight }}>{value || 'Choose font…'}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} width={330} className="fc-fontpop">
          <FontPicker
            value={value}
            onPick={(family) => {
              setAnchor(null);
              if (family !== value) onChange(family);
            }}
          />
        </Popover>
      )}
    </>
  );
}
