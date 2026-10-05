import { describe, expect, it } from 'vitest';
import { isNumberEntry } from './Dialog';

function el(html: string, sel: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelector(sel)!;
}

describe('dialog initial focus: number fields', () => {
  it('treats NumberField inputs and type=number inputs as number entries', () => {
    expect(isNumberEntry(el('<div class="ui-num"><input value="12"></div>', 'input'))).toBe(true);
    expect(isNumberEntry(el('<input type="number" value="3">', 'input'))).toBe(true);
  });

  it('keeps plain text fields as text entries', () => {
    expect(isNumberEntry(el('<input type="text" value="Untitled">', 'input'))).toBe(false);
    expect(isNumberEntry(el('<div class="ui-search"><input type="search"></div>', 'input'))).toBe(false);
    expect(isNumberEntry(el('<textarea></textarea>', 'textarea'))).toBe(false);
  });
});
