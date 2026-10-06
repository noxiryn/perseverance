import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from './Dialog';
import { MenuHost, Popover, useMenuStore } from './popover';
import { ColorField } from './color';
import { GradientField } from './gradient';
import type { Gradient } from '../../core/types';
import { escapeLayerCount, pushEscapeLayer } from './escapeLayers';
import { CommandPalette } from '../shell/CommandPalette';
import { useUI } from '../../state/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useMenuStore.getState().close();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function key(target: EventTarget, k: string) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

/** Let deferred closes (after a key's dispatch) run. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

/** A dialog with a swatch that opens a popover (like ColorField inside Edit ▸ Fill). */
function FillLike(props: {
  onDialogClose: () => void;
  onSubmit?: () => void;
  onPopoverClose?: () => void;
  popoverContent?: ReactNode;
  nested?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [inner, setInner] = useState<HTMLElement | null>(null);
  const popover =
    anchor &&
    h(Popover, {
      key: 'popover',
      anchor,
      onClose: () => {
        props.onPopoverClose?.();
        setAnchor(null);
      },
      children: [
        h('div', { key: 'content' }, props.popoverContent ?? h('input', { className: 'hex', defaultValue: '#ff0000', onKeyDown: (e: { stopPropagation(): void }) => e.stopPropagation() })),
        props.nested && h('button', { key: 'stop', className: 'stop', onClick: (e: { currentTarget: HTMLElement }) => setInner(e.currentTarget) }, 'stop colour'),
        inner && h(Popover, { key: 'inner', anchor: inner, onClose: () => setInner(null), className: 'inner', children: h('input', { className: 'inner-hex' }) }),
      ],
    });
  return h(Dialog, {
    title: 'Fill',
    onClose: props.onDialogClose,
    onSubmit: props.onSubmit,
    children: [h('button', { key: 'swatch', className: 'swatch', onClick: (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget) }, 'colour'), popover],
  });
}

describe('Escape closes only the innermost surface', () => {
  it('closes a popover opened from a dialog, then the dialog on a second Escape', () => {
    const onDialogClose = vi.fn();
    render(h(FillLike, { onDialogClose }));
    act(() => $('.swatch')!.click());
    expect($('.ui-popover')).not.toBeNull();

    key($('.swatch')!, 'Escape');
    expect($('.ui-popover')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();

    key($('.swatch')!, 'Escape');
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('works when focus is in a popover field that stops key propagation (hex input)', async () => {
    const onDialogClose = vi.fn();
    render(h(FillLike, { onDialogClose }));
    act(() => $('.swatch')!.click());
    const hex = $<HTMLInputElement>('.hex')!;
    hex.focus();
    key(hex, 'Escape');
    // Closed right after the key's dispatch (the field stopped it before it reached the document).
    await settle();
    expect($('.ui-popover')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
    key($('.swatch')!, 'Escape');
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('lets a number field inside the popover revert its typed text first, then closes the popover', async () => {
    const onDialogClose = vi.fn();
    const committed: string[] = [];
    function Num() {
      const [text, setText] = useState('12');
      return h('input', {
        className: 'num',
        value: text,
        onChange: (e: { target: HTMLInputElement }) => setText(e.target.value),
        // Like NumberField: Escape reverts, every key is kept from the global shortcuts.
        onKeyDown: (e: KeyboardEvent & { stopPropagation(): void; target: HTMLInputElement }) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            setText('12');
            committed.push('reverted');
            e.target.blur();
          }
        },
      });
    }
    render(h(FillLike, { onDialogClose, popoverContent: h(Num) }));
    act(() => $('.swatch')!.click());
    const num = $<HTMLInputElement>('.num')!;
    num.focus();
    key(num, 'Escape');
    expect(committed).toEqual(['reverted']);
    await settle();
    expect($('.ui-popover')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  it('consumes an Escape from a button inside the popover (the dialog / shortcuts behind never see it)', () => {
    const onDialogClose = vi.fn();
    const seen = vi.fn();
    const onBubble = (e: KeyboardEvent) => seen(e.key);
    window.addEventListener('keydown', onBubble);
    try {
      render(h(FillLike, { onDialogClose, popoverContent: h('button', { className: 'inside' }, 'preset') }));
      act(() => $('.swatch')!.click());
      const e = key($('.inside')!, 'Escape');
      expect($('.ui-popover')).toBeNull();
      expect(e.defaultPrevented).toBe(true);
      expect(seen).not.toHaveBeenCalled();
      expect(onDialogClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onBubble);
    }
  });

  it('leaves Escape to a control inside the popover that uses it (search field clears first)', () => {
    const onDialogClose = vi.fn();
    function Search() {
      const [q, setQ] = useState('abc');
      return h(
        'div',
        {
          onKeyDownCapture: (e: KeyboardEvent & { preventDefault(): void; stopPropagation(): void }) => {
            if (e.key === 'Escape' && q) {
              e.preventDefault();
              e.stopPropagation();
              setQ('');
            }
          },
        },
        h('input', { className: 'search', value: q, onChange: () => {} }),
      );
    }
    render(h(FillLike, { onDialogClose, popoverContent: h(Search) }));
    act(() => $('.swatch')!.click());
    const search = $<HTMLInputElement>('.search')!;
    search.focus();
    key(search, 'Escape');
    expect($<HTMLInputElement>('.search')?.value).toBe('');
    expect($('.ui-popover')).not.toBeNull();
    key($('.search')!, 'Escape');
    expect($('.ui-popover')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  it('closes only the inner one of nested popovers; a click in the inner one keeps the outer open', async () => {
    const onDialogClose = vi.fn();
    render(h(FillLike, { onDialogClose, nested: true }));
    act(() => $('.swatch')!.click());
    act(() => $('.stop')!.click());
    expect(document.querySelectorAll('.ui-popover').length).toBe(2);
    // Outside-click listeners attach on the next tick.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    act(() => {
      $('.inner-hex')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelectorAll('.ui-popover').length).toBe(2);

    key($('.inner-hex')!, 'Escape');
    expect(document.querySelectorAll('.ui-popover').length).toBe(1);
    expect($('.inner')).toBeNull();
    key($('.stop')!, 'Escape');
    expect(document.querySelectorAll('.ui-popover').length).toBe(0);
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  it('closes a context menu over a dialog without closing the dialog', () => {
    const onDialogClose = vi.fn();
    render(h('div', null, h(FillLike, { onDialogClose }), h(MenuHost)));
    act(() => useMenuStore.getState().open([{ label: 'Delete', run: () => {} }], 10, 10));
    expect($('.ui-menu')).not.toBeNull();
    key(document.body, 'Escape');
    expect($('.ui-menu')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
    key(document.body, 'Escape');
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('does not submit the dialog on Enter in a popover field', () => {
    const onDialogClose = vi.fn();
    const onSubmit = vi.fn();
    render(h(FillLike, { onDialogClose, onSubmit }));
    act(() => $('.swatch')!.click());
    key($('.hex')!, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    key($('.swatch')!, 'Enter');
    // Enter on a button belongs to the button; from the dialog frame it submits.
    key($('.ui-dialog')!, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('unregisters every layer on unmount', () => {
    render(h(FillLike, { onDialogClose: () => {}, nested: true }));
    act(() => $('.swatch')!.click());
    act(() => $('.stop')!.click());
    expect(escapeLayerCount()).toBe(3);
    render(null);
    expect(escapeLayerCount()).toBe(0);
  });

  it('a popover outside any dialog consumes Escape so global shortcuts / tools do not see it', () => {
    const seen = vi.fn();
    const onBubble = (e: KeyboardEvent) => {
      if (!e.defaultPrevented) seen(e.key);
    };
    window.addEventListener('keydown', onBubble);
    try {
      function Bar() {
        const [anchor, setAnchor] = useState<HTMLElement | null>(null);
        return h(
          'div',
          null,
          h('button', { className: 'chip', onClick: (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget) }, 'fill'),
          anchor && h(Popover, { anchor, onClose: () => setAnchor(null), children: h('span', null, 'picker') }),
        );
      }
      render(h(Bar));
      act(() => $('.chip')!.click());
      key($('.chip')!, 'Escape');
      expect($('.ui-popover')).toBeNull();
      expect(seen).not.toHaveBeenCalled();
      key($('.chip')!, 'Escape');
      expect(seen).toHaveBeenCalledWith('Escape');
    } finally {
      window.removeEventListener('keydown', onBubble);
    }
  });

  it('a dialog-kind layer on top of a popover gets the Escape (the popover behind stays open)', () => {
    const onPopoverClose = vi.fn();
    function Both() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return h(
        'div',
        null,
        h('button', { className: 'chip', onClick: (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget) }, 'fill'),
        anchor && h(Popover, { anchor, onClose: () => (onPopoverClose(), setAnchor(null)), children: h('span', null, 'picker') }),
      );
    }
    render(h(Both));
    act(() => $('.chip')!.click());
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    const seen = vi.fn();
    modal.addEventListener('keydown', (e) => seen(e.key));
    const pop = pushEscapeLayer({ kind: 'dialog', close: () => {}, contains: (n) => modal.contains(n) });
    try {
      key(modal, 'Escape');
      expect(seen).toHaveBeenCalledWith('Escape');
      expect(onPopoverClose).not.toHaveBeenCalled();
      expect($('.ui-popover')).not.toBeNull();
      // Even from outside it (focus left on the swatch): a modal surface on top is not skipped.
      key($('.chip')!, 'Escape');
      expect($('.ui-popover')).not.toBeNull();
    } finally {
      pop();
      modal.remove();
    }
    key($('.chip')!, 'Escape');
    expect(onPopoverClose).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+K over an open popover: the first Escape closes the command palette, the second the popover', () => {
    function Bar() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return h(
        'div',
        null,
        h('button', { className: 'chip', onClick: (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget) }, 'brush'),
        anchor && h(Popover, { anchor, onClose: () => setAnchor(null), children: h('span', null, 'presets') }),
        h(CommandPalette),
      );
    }
    render(h(Bar));
    act(() => $('.chip')!.click());
    act(() => useUI.getState().setCommandPalette(true));
    const input = $<HTMLInputElement>('.shell-pal input')!;
    expect(input).not.toBeNull();
    expect($('.ui-popover')).not.toBeNull();
    key(input, 'Escape');
    expect(useUI.getState().commandPaletteOpen).toBe(false);
    expect($('.shell-pal')).toBeNull();
    expect($('.ui-popover')).not.toBeNull();
    key($('.chip')!, 'Escape');
    expect($('.ui-popover')).toBeNull();
  });

  it('gives focus back to the swatch / gradient strip that opened a popover in a dialog (keyboard all the way)', async () => {
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const gradient: Gradient = { kind: 'linear', angle: 90, scale: 1, reverse: false, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
    render(
      h(Dialog, {
        title: 'Gradient Map',
        onClose: () => {},
        children: [h(ColorField, { key: 'c', value: '#ff0000', onChange: () => {} }), h(GradientField, { key: 'g', value: gradient, onChange: () => {} })],
      }),
    );
    // The colour swatch: Tab-reachable, Enter opens the picker, Escape from its hex field closes it
    // and focus is back on the swatch (it used to land on <body>).
    const swatch = $('.ui-dialog .ui-swatch')!;
    expect(swatch.tabIndex).toBe(0);
    expect(swatch.getAttribute('role')).toBe('button');
    act(() => swatch.focus());
    key(swatch, 'Enter');
    expect($('.ui-popover')).not.toBeNull();
    const hex = $<HTMLInputElement>('.ui-popover input')!;
    act(() => hex.focus());
    key(hex, 'Escape');
    await settle();
    await frame();
    expect($('.ui-popover')).toBeNull();
    expect($('.ui-dialog')).not.toBeNull();
    expect(document.activeElement).toBe(swatch);
    // The gradient strip, with the colour picker of a stop opened from its editor: two Escapes
    // close both popovers (innermost first) and focus returns to the strip.
    const strip = $('.ui-dialog [aria-label="Edit gradient"]')!;
    expect(strip.tabIndex).toBe(0);
    act(() => strip.focus());
    key(strip, ' ');
    expect(document.querySelectorAll('.ui-popover')).toHaveLength(1);
    const stopSwatch = $('.ui-popover .ui-swatch')!;
    act(() => stopSwatch.focus());
    key(stopSwatch, 'Enter');
    expect(document.querySelectorAll('.ui-popover')).toHaveLength(2);
    key(document.querySelectorAll('.ui-popover')[1].querySelector('input')!, 'Escape');
    await settle();
    await frame();
    expect(document.querySelectorAll('.ui-popover')).toHaveLength(1);
    expect(document.activeElement).toBe(stopSwatch);
    key(stopSwatch, 'Escape');
    await settle();
    await frame();
    expect(document.querySelectorAll('.ui-popover')).toHaveLength(0);
    expect($('.ui-dialog')).not.toBeNull();
    expect(document.activeElement).toBe(strip);
  });
});
