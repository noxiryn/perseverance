import { useCallback, useRef } from 'react';

/**
 * Enter-to-submit that respects fields still being edited.
 *
 * The shared <Dialog> handles Enter in the capture phase, i.e. BEFORE a focused NumberField has
 * committed its typed text (NumberField commits on blur). This wrapper blurs the focused field
 * first (committing its value through React state), then runs the LATEST `submit` closure on the
 * next task, after React has re-rendered with the committed value.
 */
export function useDeferredSubmit(submit: () => void): () => void {
  const latest = useRef(submit);
  latest.current = submit;
  return useCallback(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.blur();
      window.setTimeout(() => latest.current(), 0);
      return;
    }
    latest.current();
  }, []);
}
