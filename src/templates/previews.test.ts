import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Rendering a real template needs a canvas: a preview here is a fixed data URL (or a failure).
const render = vi.hoisted(() => ({ fail: new Set<string>(), calls: [] as string[] }));
vi.mock('../render/compositor', () => ({
  renderDocument: (doc: { name: string }) => {
    render.calls.push(doc.name);
    if (render.fail.has(doc.name)) throw new Error('render failed');
    return { toDataURL: () => `data:image/png;base64,${doc.name}` };
  },
}));
vi.mock('./define', () => ({ hasTemplateSpec: () => false, buildTemplate: vi.fn() }));

import { templates, type TemplateDef } from '../registry';
import {
  cancelPendingTemplatePreviews,
  clearTemplatePreviews,
  getTemplatePreview,
  loadTemplatePreview,
  pauseTemplatePreviews,
  useTemplatePreviewState,
  type TemplatePreviewState,
} from './previews';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDS = ['tpl-prev-a', 'tpl-prev-b', 'tpl-prev-c'];
const def = (id: string): TemplateDef => ({
  id,
  name: id,
  category: 'Thumbnail',
  width: 64,
  height: 36,
  build: () => ({ name: id, width: 64, height: 36, layers: {}, rootIds: [] }) as never,
});

/** Let the idle queue run its jobs (each waits for an idle period, up to 250 ms). */
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, ms = 4000) {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await wait(20);
}

beforeEach(() => {
  for (const id of IDS) templates.register(def(id));
  render.fail.clear();
  render.calls.length = 0;
  pauseTemplatePreviews(false);
});

afterEach(() => {
  pauseTemplatePreviews(false);
  cancelPendingTemplatePreviews();
  clearTemplatePreviews();
  for (const id of IDS) templates.unregister(id);
});

describe('template previews', () => {
  it('a request made right after a cancel queues a new job instead of returning the cancelled one', async () => {
    pauseTemplatePreviews(true);
    const first = loadTemplatePreview('tpl-prev-a');
    cancelPendingTemplatePreviews();
    const second = loadTemplatePreview('tpl-prev-a');
    expect(second).not.toBe(first);
    pauseTemplatePreviews(false);
    expect(await first).toBeNull();
    expect(await second).toBe('data:image/png;base64,tpl-prev-a');
    expect(getTemplatePreview('tpl-prev-a')).toBe('data:image/png;base64,tpl-prev-a');
    expect(render.calls).toEqual(['tpl-prev-a']);
  });

  it('the cancelled promise settling later does not orphan the new request', async () => {
    pauseTemplatePreviews(true);
    const first = loadTemplatePreview('tpl-prev-b');
    cancelPendingTemplatePreviews();
    const second = loadTemplatePreview('tpl-prev-b');
    await first; // its cleanup runs now, while the second request is pending
    expect(loadTemplatePreview('tpl-prev-b')).toBe(second);
    pauseTemplatePreviews(false);
    expect(await second).toBe('data:image/png;base64,tpl-prev-b');
  });

  it('start-screen cards get their previews after New from Template closes and cancels the queue', async () => {
    const states: Record<string, TemplatePreviewState> = {};
    function Card({ id, visible }: { id: string; visible: boolean }) {
      states[id] = useTemplatePreviewState(id, visible);
      return null;
    }
    function DialogCards() {
      // NewFromTemplateDialog drops the previews still queued when it closes.
      useEffect(() => () => cancelPendingTemplatePreviews(), []);
      return h(Card, { id: 'tpl-prev-c', visible: true });
    }
    // The start screen requests previews only while no dialog is up.
    const App = ({ dialog }: { dialog: boolean }) =>
      h('div', null, h(Card, { id: 'tpl-prev-a', visible: !dialog }), h(Card, { id: 'tpl-prev-b', visible: !dialog }), dialog && h(DialogCards));

    const host = document.createElement('div');
    const root: Root = createRoot(host);
    try {
      pauseTemplatePreviews(true); // nothing finishes before the dialog opens
      act(() => root.render(h(App, { dialog: false })));
      expect(states['tpl-prev-a'].loading).toBe(true);
      act(() => root.render(h(App, { dialog: true })));
      act(() => root.render(h(App, { dialog: false }))); // closes: cancel + re-request in one commit
      pauseTemplatePreviews(false);
      await until(() => !!states['tpl-prev-a'].url && !!states['tpl-prev-b'].url);
      expect(states['tpl-prev-a']).toEqual({ url: 'data:image/png;base64,tpl-prev-a', loading: false });
      expect(states['tpl-prev-b']).toEqual({ url: 'data:image/png;base64,tpl-prev-b', loading: false });
    } finally {
      act(() => root.unmount());
    }
  });

  it('a visible card asks again after its request was cancelled, but not after a failure', async () => {
    const states: Record<string, TemplatePreviewState> = {};
    function Card({ id }: { id: string }) {
      states[id] = useTemplatePreviewState(id, true);
      return null;
    }
    render.fail.add('tpl-prev-b');
    const host = document.createElement('div');
    const root: Root = createRoot(host);
    try {
      pauseTemplatePreviews(true);
      act(() => root.render(h('div', null, h(Card, { id: 'tpl-prev-a' }), h(Card, { id: 'tpl-prev-b' }))));
      await act(async () => cancelPendingTemplatePreviews());
      expect(states['tpl-prev-a'].loading).toBe(true); // re-requested
      pauseTemplatePreviews(false);
      await until(() => !!states['tpl-prev-a'].url && !states['tpl-prev-b'].loading);
      expect(states['tpl-prev-a'].url).toBe('data:image/png;base64,tpl-prev-a');
      expect(states['tpl-prev-b']).toEqual({ url: null, loading: false }); // still placeholder, no shimmer
      await wait(600);
      expect(render.calls.filter((c) => c === 'tpl-prev-b')).toHaveLength(1); // no retry loop
    } finally {
      act(() => root.unmount());
    }
  });
});
