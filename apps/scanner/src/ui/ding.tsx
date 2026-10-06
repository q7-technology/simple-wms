/** The green "Ding!" toast: a short, cheerful yes after a line or task is
 * confirmed. One toast at a time, shared by every screen (it outlives a
 * navigation, so "Ding!" still shows on the next line or the menu). */
import { useSyncExternalStore } from "react";

export const DING_MS = 2200;

interface Toast { id: number; text: string }

let current: Toast | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

/** Show the toast. `text` is what follows "Ding!", e.g. "Picked 6 EA GHI789". */
export function ding(text: string) {
  current = { id: nextId++, text };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { current = null; timer = null; emit(); }, DING_MS);
  emit();
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
function snapshot() { return current; }

export function DingToast() {
  const toast = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The live region is always there so a screen reader hears each new ding.
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute top-[72px] left-0 right-0 z-30 h-0">
      {toast && (
        <div key={toast.id} className="ding absolute left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-[18px] py-3 rounded-full bg-ok-strong text-white font-extrabold text-[15px] shadow-float max-w-[calc(100vw-32px)]">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m5 12 5 5 9-10" /></svg>
          <span className="truncate">Ding! {toast.text}</span>
        </div>
      )}
    </div>
  );
}
