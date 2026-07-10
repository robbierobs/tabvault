// React glue for EditorController: one controller per Player mount, state
// mirrored into React via useSyncExternalStore. The controller reads live
// values through the getter functions in opts, so opts can be rebuilt every
// render without re-wiring anything.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { EditorController } from './editor.js';

export function useEditor(opts) {
  const ref = useRef(null);
  if (!ref.current) ref.current = new EditorController(opts);
  ref.current.opts = opts; // keep getters fresh
  if (import.meta.env.DEV) window.__tabvaultEditor = ref.current; // e2e/debug handle

  useEffect(() => {
    const controller = ref.current;
    return () => controller.dispose();
  }, []);

  const snapshot = useSyncExternalStore(ref.current.subscribe, ref.current.getSnapshot);
  return { editor: ref.current, ed: snapshot };
}
