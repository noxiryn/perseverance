/**
 * Cache lifecycle: drops the cached renders of layers that left their document (deleted,
 * merged…) and of closed documents, so they never sit in the render cache until LRU pressure
 * happens to reach them. Undoing a deletion simply re-renders the layer.
 */
import type { Document, ID, Layer } from '../core/types';
import { useEditor } from '../state/editor';
import { objId, slots } from './cache';
import { docTag, dropLiveComposites, forgetLayer } from './engine';
import { maskTag } from './mask';

function dropLayer(id: ID, l: Layer) {
  slots.clear(id, { composites: false });
  if (l.mask) slots.clear(maskTag(l.mask.bitmapId), { composites: false });
  if (l.type === 'text') slots.delete(`text|${objId(l.text)}`);
  if (l.type === 'shape') slots.delete(`shape|${objId(l.shape)}`);
  forgetLayer(id);
}

/** Layers of `a` that are not in `b` (all of them when the document closed). */
function dropRemoved(a: Document, b: Document | undefined) {
  for (const id in a.layers) if (!b || !(id in b.layers)) dropLayer(id, a.layers[id]);
}

let installed = false;

export function installCacheLifecycle() {
  if (installed) return;
  installed = true;
  let prev = useEditor.getState().sessions;
  useEditor.subscribe((state) => {
    const cur = state.sessions;
    if (cur === prev) return;
    const old = prev;
    prev = cur;
    for (const sid in old) {
      const a = old[sid].doc;
      const b = cur[sid]?.doc;
      if (b === a || (b && b.layers === a.layers)) continue;
      dropRemoved(a, b);
      if (!b) {
        slots.clear(docTag(a.id), { composites: false });
        dropLiveComposites(a.id);
      }
    }
  });
}
