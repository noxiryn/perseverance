import { useCallback, useRef } from 'react';

/**
 * Submit callback that always sees committed field values.
 *
 * NumberField/TextInput commit their typed text on blur. The shared <Dialog> now blurs a focused
 * text field on Enter and submits with its latest handler; this hook keeps the same guarantee for
 * every other caller (footer buttons, programmatic submits): it blurs a still-focused field first
 * and runs the LATEST `submit` closure after React has re-rendered with the committed value. The
 * returned callback is stable.
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
