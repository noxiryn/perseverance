import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from './Dialog';
import { MenuHost, Popover, useMenuStore } from './popover';
import { escapeLayerCount } from './escapeLayers';

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

  it('works when focus is in a popover field that stops key propagation (hex input)', () => {
    const onDialogClose = vi.fn();
    render(h(FillLike, { onDialogClose }));
    act(() => $('.swatch')!.click());
    const hex = $<HTMLInputElement>('.hex')!;
    hex.focus();
    const e = key(hex, 'Escape');
    expect($('.ui-popover')).toBeNull();
    expect(e.defaultPrevented).toBe(true);
    expect(onDialogClose).not.toHaveBeenCalled();
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
});
