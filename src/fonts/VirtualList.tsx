/**
 * Small virtualized list with variable (but known) row heights. Only rows inside the viewport
 * (plus an overscan margin) are mounted — font previews mount (and load their face) on demand.
 *
 * Scroll anchoring: when the items (or their heights) change, the first visible row that still
 * exists (matched by key) stays at the same place on screen, so rows inserted above the viewport
 * (a new favorite, fonts that finished loading…) never move what the user is looking at.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: 'auto' | 'start' | 'center'): void;
  scrollToTop(): void;
}

export interface VirtualListProps<T> {
  items: T[];
  itemHeight: (item: T, index: number) => number;
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Extra px rendered above/below the viewport. */
  overscan?: number;
  className?: string;
  style?: CSSProperties;
  listRef?: Ref<VirtualListHandle>;
  /** Rendered when there are no items. */
  empty?: ReactNode;
  /** Keep the first visible row in place when items change (default true). */
  keepAnchor?: boolean;
}

/** Index of the last offset <= y (offsets ascending, length n+1). */
export function findIndex(offsets: ArrayLike<number>, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Scroll position that keeps the first visible row (that still exists, matched by key) at the
 * same place on screen after the list changed. Null when no adjustment is needed (at the top, or
 * none of the previously visible rows survived). `oldOffsets` / `newOffsets` have length n+1.
 */
export function anchoredScrollTop(
  oldKey: (index: number) => string,
  oldOffsets: ArrayLike<number>,
  newKeys: readonly string[],
  newOffsets: ArrayLike<number>,
  scrollTop: number,
  viewHeight: number,
): number | null {
  const oldCount = oldOffsets.length - 1;
  if (scrollTop <= 0 || oldCount <= 0 || !newKeys.length) return null; // at the top: stay there
  const index = new Map<string, number>();
  newKeys.forEach((k, i) => index.set(k, i));
  const bottom = scrollTop + Math.max(1, viewHeight);
  for (let i = findIndex(oldOffsets, scrollTop); i < oldCount && oldOffsets[i] < bottom; i++) {
    const j = index.get(oldKey(i));
    if (j === undefined) continue;
    return Math.max(0, scrollTop + newOffsets[j] - oldOffsets[i]);
  }
  return null;
}

export function VirtualList<T>({
  items,
  itemHeight,
  itemKey,
  renderItem,
  overscan = 240,
  className,
  style,
  listRef,
  empty,
  keepAnchor = true,
}: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const raf = useRef(0);

  const offsets = useMemo(() => {
    const o = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + itemHeight(items[i], i);
    return o;
  }, [items, itemHeight]);
  const total = offsets[items.length];

  // Scroll anchoring (see header). Runs before paint, so the adjustment never flickers.
  const prev = useRef<{ items: T[]; offsets: Float64Array } | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = { items, offsets };
    const el = ref.current;
    if (!keepAnchor || !before || !el || before.offsets === offsets) return;
    const st = el.scrollTop;
    const next = anchoredScrollTop(
      (i) => itemKey(before.items[i], i),
      before.offsets,
      items.map((it, i) => itemKey(it, i)),
      offsets,
      st,
      el.clientHeight,
    );
    if (next !== null && Math.abs(next - st) >= 0.5) {
      el.scrollTop = next;
      setScrollTop(el.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only list changes re-anchor
  }, [items, offsets, keepAnchor]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewH(el.clientHeight || 400);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (ref.current) setScrollTop(ref.current.scrollTop);
    });
  }, []);

  useImperativeHandle(
    listRef,
    () => ({
      scrollToIndex(index, align = 'auto') {
        const el = ref.current;
        if (!el || index < 0 || index >= items.length) return;
        const top = offsets[index];
        const h = offsets[index + 1] - top;
        let next = el.scrollTop;
        if (align === 'start') next = top;
        else if (align === 'center') next = top - (el.clientHeight - h) / 2;
        else if (top < el.scrollTop) next = top;
        else if (top + h > el.scrollTop + el.clientHeight) next = top + h - el.clientHeight;
        el.scrollTop = Math.max(0, next);
        setScrollTop(el.scrollTop);
      },
      scrollToTop() {
        if (ref.current) ref.current.scrollTop = 0;
        setScrollTop(0);
      },
    }),
    [items.length, offsets],
  );

  // Clamp when the list shrinks (e.g. after filtering).
  const top = Math.min(scrollTop, Math.max(0, total - viewH));
  const start = findIndex(offsets, Math.max(0, top - overscan));
  const endY = top + viewH + overscan;
  const rows: ReactNode[] = [];
  for (let i = start; i < items.length && offsets[i] < endY; i++) {
    rows.push(
      <div
        key={itemKey(items[i], i)}
        style={{ position: 'absolute', left: 0, right: 0, top: offsets[i], height: offsets[i + 1] - offsets[i] }}
      >
        {renderItem(items[i], i)}
      </div>,
    );
  }

  return (
    <div ref={ref} className={className} style={{ overflowY: 'auto', position: 'relative', ...style }} onScroll={onScroll}>
      {items.length === 0 ? empty : <div style={{ height: total, position: 'relative' }}>{rows}</div>}
    </div>
  );
}
