/**
 * Font family picker. Props are a stable contract; the fonts module may enhance the internals
 * (previews in each font, categories, search, favorites, system fonts).
 */
import { fonts, useRegistry } from '../../registry';
import { ensureFont } from '../../fonts/loader';

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
  const known = list.some((f) => f.family === value);
  return (
    <select
      className="ui-select"
      style={{ width, fontFamily: `"${value}", var(--font-ui)` }}
      value={value}
      onChange={(e) => {
        void ensureFont(e.target.value);
        onChange(e.target.value);
      }}
    >
      {!known && <option value={value}>{value}</option>}
      {list.map((f) => (
        <option key={f.id} value={f.family}>
          {f.family}
        </option>
      ))}
    </select>
  );
}
