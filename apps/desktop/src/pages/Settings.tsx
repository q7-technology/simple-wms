import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Warehouse, WarehouseSettings } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useAction, useApi } from "../lib/useApi";
import { Button, Card, Chip, Eyebrow, Field, Input, Muted, Notice, PageHeader, SegmentedChoice, Toggle } from "../ui";
import { Main } from "../ui/Shell";
import { useGamePrefs } from "../lib/gamePrefs";

type BoolKey = { [K in keyof WarehouseSettings]: WarehouseSettings[K] extends boolean ? K : never }[keyof WarehouseSettings];
type NumKey = { [K in keyof WarehouseSettings]: WarehouseSettings[K] extends number ? K : never }[keyof WarehouseSettings];

const SAVED_FOR_MS = 3000;

export function Settings() {
  const { warehouse, warehouses, reloadWarehouses, can } = useAuth();
  const editable = can("master:write");
  const [chosen, setChosen] = useState<string | null>(null);
  const code = chosen ?? warehouse?.code ?? null;

  const loaded = useApi<Warehouse>(
    code ? () => api.get<Warehouse>(`/v1/warehouses/${encodeURIComponent(code)}`) : null,
    [code],
  );
  const [draft, setDraft] = useState<Partial<WarehouseSettings>>({});
  const [texts, setTexts] = useState<Partial<Record<NumKey, string>>>({});
  const [saved, setSaved] = useState(false);
  const action = useAction();

  useEffect(() => { setDraft({}); setTexts({}); action.clear(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), SAVED_FOR_MS);
    return () => clearTimeout(t);
  }, [saved]);

  const base = loaded.data?.settings;
  const current: Partial<WarehouseSettings> = { ...base, ...draft };
  const changes = Object.fromEntries(
    (Object.keys(draft) as (keyof WarehouseSettings)[])
      .filter((k) => base && draft[k] !== base[k])
      .map((k) => [k, draft[k]]),
  ) as Partial<WarehouseSettings>;
  const dirty = Object.keys(changes).length > 0;

  const setBool = (key: BoolKey) => (v: boolean) => setDraft((d) => ({ ...d, [key]: v }));
  const setNumber = (key: NumKey, text: string) => {
    setTexts((t) => ({ ...t, [key]: text }));
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      setDraft((d) => { const next = { ...d }; delete next[key]; return next; });
    } else {
      setDraft((d) => ({ ...d, [key]: n }));
    }
  };

  const save = async () => {
    if (!code || !dirty) return;
    const result = await action.run(() =>
      api.patch<Warehouse | WarehouseSettings>(`/v1/warehouses/${encodeURIComponent(code)}/settings`, changes),
    );
    if (result === undefined) return;
    const settings = "settings" in result ? result.settings : result;
    loaded.setData(loaded.data ? { ...loaded.data, settings } : loaded.data);
    setDraft({});
    setTexts({});
    setSaved(true);
    await reloadWarehouses();
  };

  const bool = (key: BoolKey, label: ReactNode, hint?: ReactNode) => (
    <Toggle label={label} hint={hint} checked={current[key] ?? false} onChange={editable ? setBool(key) : undefined} disabled={!editable} />
  );
  const num = (key: NumKey, label: ReactNode) => (
    <Field label={label} className="grow" error={action.fieldErrors[key]}>
      <Input
        aria-label={typeof label === "string" ? label : undefined}
        type="number"
        value={texts[key] ?? (current[key] === undefined ? "" : String(current[key]))}
        onChange={(e) => setNumber(key, e.target.value)}
        disabled={!editable}
      />
    </Field>
  );

  const fieldErrors = Object.entries(action.fieldErrors);

  return (
    <Main>
      <PageHeader
        eyebrow="Per warehouse"
        accent="Settings"
        title={`· ${code ?? "—"}`}
        actions={<>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            {warehouses.map((w) => (
              <Chip key={w.code} active={w.code === code} onClick={() => setChosen(w.code)}>{w.code} · {w.name}</Chip>
            ))}
            <span
              title="Defaults live in the API for now"
              aria-disabled="true"
              className="inline-block rounded-full border border-dashed border-line-strong bg-ground px-2.5 py-1 text-xs leading-4 font-bold whitespace-nowrap text-muted cursor-not-allowed"
            >
              Global defaults
            </span>
          </div>
          {saved && <Muted className="text-sm">Saved</Muted>}
          {editable && <Button variant="primary" disabled={!dirty || action.busy || !base} onClick={() => void save()}>Save changes</Button>}
        </>}
      />

      <GameFeel />

      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-extrabold">Warehouse settings</h2>
        <Muted className="text-[13px]">Saved to the WMS for everyone at {code ?? "this warehouse"}. Changes need Save changes.</Muted>
      </div>
      {loaded.error && <Notice tone="gold">{loaded.error}</Notice>}
      {action.error && (
        <Notice tone="gold">
          {fieldErrors.length > 0 ? fieldErrors.map(([k, m]) => `${k.replace(/_/g, " ")}: ${m}`).join("; ") : action.error}
        </Notice>
      )}
      {!editable && <Notice>Read only. Changing settings needs the master data write scope.</Notice>}
      {!code && !loaded.loading && <Notice>No warehouse yet. Create one through the API and its switches show up here.</Notice>}
      {loaded.loading && !loaded.data && <Muted className="text-sm">Loading…</Muted>}

      {base && (
        <div className="grid grid-cols-2 gap-6">
          <Group title="Receiving and production">
            {bool("erp_counts_gr", "ERP already counts production stock", "WMS assigns bins only, sends no goods receipt")}
            {bool("batch_from_production_order", "Batch from production order code", "Read-only on the scanner")}
            <div className="flex gap-2 pt-2">
              {num("receipt_tolerance_pct", "Over-receipt tolerance %")}
              {num("supplier_tolerance_pct", "Supplier tolerance %")}
            </div>
          </Group>

          <Group title="Picking and shipping">
            {bool("allow_ship_short", "Ship short allowed", "Delivery amended down to what was picked")}
            {bool("supervisor_for_short_pick", "Supervisor badge for short pick", "Required on the scanner")}
            <div className="flex items-center justify-between gap-4 py-2.5 row-line">
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm leading-5 text-ink">Auto pick mode</span>
                <span className="text-xs leading-4 text-muted">Batch when 3+ small orders share a zone</span>
              </span>
              <SegmentedChoice
                value={current.auto_pick_mode ?? "single"}
                options={[{ value: "single", label: "Single" }, { value: "batch", label: "Batch" }, { value: "auto", label: "Auto" }]}
                onChange={(v) => setDraft((d) => ({ ...d, auto_pick_mode: v }))}
                disabled={!editable}
              />
            </div>
            <div className="flex gap-2 pt-2">
              {num("batch_pick_max_orders", "Batch pick max orders")}
            </div>
          </Group>

          <Group title="Scanners and security">
            <div className="flex gap-2 pb-2">
              {num("idle_logout_minutes", "Idle logout (min)")}
              {num("pin_lockout_tries", "PIN lockout tries")}
            </div>
            {bool("known_devices_only", "Known devices only", "A PIN works only on a registered scanner")}
            {bool("queue_offline_confirmations", "Queue confirmations when offline", "Retry on reconnect, max 200")}
          </Group>

          <Group title="Stock rules">
            {bool("fifo_by_received_date", "FIFO by received date", "Oldest stock is picked first")}
            {bool("blind_counts", "Blind cycle counts", "Expected quantity hidden from counter")}
            {bool("decimals_allowed", "Decimals allowed", "Weight and volume products")}
          </Group>

          <Group title="Printing · Platen">
            <Field label="Platen URL" className="pb-2" error={action.fieldErrors.platen_url}>
              <Input
                aria-label="Platen URL"
                type="url"
                placeholder="https://platen.internal/jobs"
                value={current.platen_url ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, platen_url: e.target.value.trim() || null }))}
                disabled={!editable}
              />
            </Field>
            {bool("retry_failed_print_jobs", "Retry failed print jobs", "Same queue as events")}
            <div className="flex gap-2 pt-2">
              {num("default_copies", "Default copies")}
            </div>
          </Group>

          <Group title="Data">
            <Toggle
              label="Multiple owners"
              hint="Third-party warehousing: show the owner on every screen"
              checked={(current as Record<string, unknown>).multi_owner === true}
              onChange={editable ? (v) => setDraft((d) => ({ ...d, multi_owner: v } as Partial<WarehouseSettings>)) : undefined}
              disabled={!editable}
            />
            <Muted className="text-xs leading-4 pb-2"><Link to="/owners">Manage owners</Link></Muted>
            <div className="flex gap-2 pb-2">
              {num("ledger_retention_years", "Ledger retention (years)")}
              {num("duplicate_window_hours", "Duplicate window (h)")}
            </div>
            <Toggle label="Allow hard deletes" hint="Never · cancel instead" checked={false} disabled />
            <Muted className="text-xs leading-4">This one cannot be switched on. Kept here so nobody asks.</Muted>
          </Group>
        </div>
      )}
    </Main>
  );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-6 flex flex-col gap-2">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </Card>
  );
}

/** Viewer preferences. They live in this browser only and never reach the
 * API, so they are kept well apart from the warehouse's own switches. */
function GameFeel() {
  const [prefs, setPrefs] = useGamePrefs();
  return (
    <section aria-labelledby="game-feel-h" className="card p-6 flex flex-col gap-2">
      <div className="flex flex-col gap-1 pb-1">
        <h2 id="game-feel-h" className="m-0 text-[17px] font-extrabold">Game feel</h2>
        <Muted className="text-[13px]">Just for you, on this computer. Saved in this browser, not in the WMS, and nobody else sees them.</Muted>
      </div>
      <Toggle
        label="Sounds"
        icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg>}
        hint="A beep when a truck arrives, a ding when an order ships"
        checked={prefs.sound}
        onChange={(v) => setPrefs({ sound: v })}
      />
      <label className="flex items-center gap-3 py-2 pl-14 min-h-11 row-line text-[13px] font-bold text-ink-2">
        <span>Volume</span>
        <input
          type="range" min={0} max={100} step={5}
          value={prefs.volume}
          disabled={!prefs.sound}
          onChange={(e) => setPrefs({ volume: Number(e.target.value) })}
          className="grow accent-brand h-7"
        />
        <span className="w-10 text-right text-ink">{prefs.volume}%</span>
      </label>
      <Toggle
        label="Day and night"
        icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>}
        hint="The map gets darker as the day ends, on the warehouse's own clock"
        checked={prefs.dayNight}
        onChange={(v) => setPrefs({ dayNight: v })}
      />
      <Toggle
        label="Moving trucks and forklifts"
        icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h10v9H3zM13 10h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.6" /><circle cx="17" cy="17.5" r="1.6" /></svg>}
        hint="Turn off if the computer feels slow. Always off when your computer asks for less motion."
        checked={prefs.motion}
        onChange={(v) => setPrefs({ motion: v })}
      />
      <Muted className="text-xs leading-4 pt-1">
        No weather on the map: the WMS has no weather feed, so the sky only follows day and night.
      </Muted>
    </section>
  );
}
