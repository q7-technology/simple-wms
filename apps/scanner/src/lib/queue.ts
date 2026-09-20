/** Confirmations queued through a Wi-Fi drop. Each carries its message_id
 * from the moment it is created, so a retry gets the same reply and never
 * doubles a movement. */

export interface QueueItem {
  id: string;
  message_id: string;
  path: string;
  body: Record<string, unknown>;
  label: string;
  created_at: string;
  status: "queued" | "sent" | "failed";
  attempts: number;
  reply?: unknown;
  error?: string;
}

type Sender = (init: { path: string; body: string }) => Promise<Response>;
interface Storage {
  get(key: string): string | undefined;
  set(key: string, value: string): unknown;
}

const KEY = "wms.scanner.queue";
const MAX = 200;

function browserStorage(): Storage {
  return {
    get: (k) => { try { return window.localStorage.getItem(k) ?? undefined; } catch { return undefined; } },
    set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
}

export class RetryQueue {
  private items: QueueItem[] = [];
  private send: Sender;
  private storage: Storage;
  private online: () => boolean;
  private draining = false;
  listeners = new Set<() => void>();

  constructor(opts: { send: Sender; storage?: Storage; online?: () => boolean }) {
    this.send = opts.send;
    this.storage = opts.storage ?? browserStorage();
    this.online = opts.online ?? (() => typeof navigator === "undefined" || navigator.onLine);
    try {
      this.items = JSON.parse(this.storage.get(KEY) ?? "[]") as QueueItem[];
    } catch {
      this.items = [];
    }
  }

  private save() {
    this.items = this.items.slice(-MAX);
    this.storage.set(KEY, JSON.stringify(this.items));
    this.listeners.forEach((fn) => fn());
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  all(): QueueItem[] { return this.items.slice().reverse(); }
  pending(): QueueItem[] { return this.items.filter((i) => i.status === "queued"); }
  failed(): QueueItem[] { return this.items.filter((i) => i.status === "failed"); }

  /** Send now if online; otherwise queue. Either way the caller gets the item. */
  async submit(input: { path: string; body: Record<string, unknown>; label: string }): Promise<QueueItem> {
    const item: QueueItem = {
      id: crypto.randomUUID(), message_id: crypto.randomUUID(), path: input.path, body: input.body,
      label: input.label, created_at: new Date().toISOString(), status: "queued", attempts: 0,
    };
    this.items.push(item);
    this.save();
    if (this.online()) await this.attempt(item);
    return item;
  }

  private async attempt(item: QueueItem): Promise<void> {
    item.attempts += 1;
    try {
      const res = await this.send({ path: item.path, body: JSON.stringify({ message_id: item.message_id, ...item.body }) });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (res.ok) {
        item.status = "sent";
        item.reply = parsed;
        item.error = undefined;
      } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429) {
        // the server understood and said no; retrying cannot help
        item.status = "failed";
        item.error = describe(parsed, res.status);
      } else {
        item.error = describe(parsed, res.status);
      }
    } catch (e) {
      item.error = e instanceof Error ? e.message : "network error";
    }
    this.save();
  }

  /** Try everything still queued, oldest first. Returns how many got through. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let sent = 0;
    try {
      for (const item of this.items.filter((i) => i.status === "queued")) {
        if (!this.online()) break;
        await this.attempt(item);
        if (item.status === "sent") sent += 1;
        else if (item.status === "queued") break; // still no network; keep order
      }
    } finally {
      this.draining = false;
    }
    return sent;
  }

  clearFinished() {
    this.items = this.items.filter((i) => i.status === "queued");
    this.save();
  }
}

function describe(body: unknown, status: number): string {
  const errors = (body as { errors?: { field: string; message: string }[] })?.errors;
  if (errors?.length) return errors.map((e) => `${e.field}: ${e.message}`).join("; ");
  const detail = (body as { detail?: string })?.detail;
  return typeof detail === "string" ? detail : `HTTP ${status}`;
}
