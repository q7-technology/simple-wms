import { useEffect, useState } from "react";

/** A small "Ding!" after something went through. One shared place, so every
 * panel says it the same way. It never carries anything you need to read:
 * the panel itself still shows what happened. */

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export function ding(text = "That's done.") {
  listeners.forEach((l) => l(text));
}

const SHOW_MS = 2600;

export function ToastHost() {
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const listener: Listener = (text) => setToast({ text, n: ++n });
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div aria-live="polite" className="pointer-events-none absolute left-1/2 bottom-6 z-40 -translate-x-1/2">
      {toast && (
        <div key={toast.n} className="wm-toast flex items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-[0_10px_30px_rgba(24,35,61,0.25)]">
          <span aria-hidden="true" className="grid place-items-center w-7 h-7 rounded-full bg-ok-fill">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
          </span>
          <span className="text-sm font-bold"><span className="font-extrabold">Ding!</span> {toast.text}</span>
        </div>
      )}
    </div>
  );
}
