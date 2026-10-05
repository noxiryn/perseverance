import { useCallback, useRef } from 'react';

/**
 * Enter-to-submit that always sees committed field values.
 *
 * NumberField/TextInput commit their typed text on blur. The shared <Dialog> blurs a focused text
 * field on Enter and calls onSubmit on the next tick — but it calls the onSubmit closure from the
 * render BEFORE the commit, which still holds the old values. This returns a stable callback
 * that runs the LATEST `submit` closure (and blurs a still-focused field first when it is called
 * from a button), so the dialog submits exactly what the user typed.
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
