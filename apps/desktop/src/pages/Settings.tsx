import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Warehouse, WarehouseSettings } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useAction, useApi } from "../lib/useApi";
import { Button, Card, Chip, Eyebrow, Field, Input, Muted, Notice, PageHeader, SegmentedChoice, Toggle } from "../ui";
import { Main } from "../ui/Shell";

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
              className="inline-block rounded-full border border-line px-2 py-0.5 text-xs leading-4 font-semibold whitespace-nowrap text-muted opacity-50 cursor-not-allowed"
            >
              Global defaults
            </span>
          </div>
          {saved && <Muted className="text-sm">Saved</Muted>}
          {editable && <Button variant="primary" disabled={!dirty || action.busy || !base} onClick={() => void save()}>Save changes</Button>}
        </>}
      />

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
