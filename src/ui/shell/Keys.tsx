/** Keycap rendering for shortcuts ('Ctrl+Shift+N' → [Ctrl][Shift][N], or ⌘⇧N on macOS). */
import { isMac } from '../../platform';
import { formatShortcut } from '../shortcuts';

export function shortcutKeys(s: string): string[] {
  const f = formatShortcut(s);
  if (isMac) {
    const m = f.match(/^([⌘⌥⇧]*)(.*)$/);
    return m ? [...m[1], m[2]].filter(Boolean) : [f];
  }
  // Keep a trailing '+' key ('Ctrl++').
  const parts = f.split('+');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1 && out.length) out.push('+');
    else if (parts[i] !== '') out.push(parts[i]);
  }
  return out;
}

export function Keys({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <span className={['shell-kbd-group', className].filter(Boolean).join(' ')}>
      {shortcutKeys(shortcut).map((k, i) => (
        <kbd key={i} className="shell-kbd">
          {k.length === 1 ? k.toUpperCase() : k}
        </kbd>
      ))}
    </span>
  );
}
