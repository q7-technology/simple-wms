import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Location, Page, StockAtShelf, Zone } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, Muted, Notice, PageHeader, SearchInput,
  Section, SegmentedChoice, Select, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/* The printer is asked for once and remembered, not stored per screen. */
const PRINTER_KEY = "wms.printer";
function readPrinter(): string {
  try { return window.localStorage.getItem(PRINTER_KEY) ?? ""; } catch { return ""; }
}
function rememberPrinter(name: string) {
  try { window.localStorage.setItem(PRINTER_KEY, name); } catch { /* private mode */ }
}

type LocType = Location["type"];
type Access = Location["access"];
type Mixing = Location["mixing"];

const TYPE_LABEL: Record<LocType, string> = {
  shelf: "Shelf", rack: "Pallet rack", floor: "Floor", dock: "Dock", line_side: "Drop point", in_transit: "In transit",
};
const TYPE_OPTIONS: LocType[] = ["shelf", "rack", "floor", "dock", "line_side", "in_transit"];
const ACCESS_LABEL: Record<Access, string> = { ground: "Ground", step: "Step", forklift: "Forklift" };
const ZONE_KINDS = ["bulk", "pickface", "staging", "in_transit", "overflow", "line_side"] as const;

function mixingLabel(m: Mixing): string {
  if (m === "single_sku") return "No · one SKU";
  if (m === "single_batch") return "One batch";
  return "Yes";
}

function capacityLabel(l: Location): string {
  if (l.capacity === null || l.capacity === "") return "—";
  return fmtQty(l.capacity, l.capacity_uom ?? undefined);
}

function holdingLabel(s: StockAtShelf): string {
  if (s.stock.length === 0) return "Empty";
  return s.stock.map((line) => `${line.sku} ×${fmtQty(line.on_hand)}`).join(", ");
}

/** The form's view of a location. Strings throughout so the inputs stay controlled. */
interface Draft {
  code: string;
  zone: string;
  type: LocType;
  access: Access;
  mixing: Mixing;
  pick_sequence: string;
  capacity: string;
  capacity_uom: string;
  barcode: string;
}

function emptyDraft(zone = ""): Draft {
  return { code: "", zone, type: "shelf", access: "ground", mixing: "mixed", pick_sequence: "", capacity: "", capacity_uom: "", barcode: "" };
}

function draftOf(l: Location): Draft {
  return {
    code: l.code, zone: l.zone, type: l.type, access: l.access, mixing: l.mixing,
    pick_sequence: String(l.pick_sequence), capacity: l.capacity ?? "", capacity_uom: l.capacity_uom ?? "",
    barcode: l.barcode ?? "",
  };
}

export function Locations() {
  const { warehouse, can } = useAuth();
  const code = warehouse?.code;
  const writable = can("master:write");

  const [search, setSearch] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Location | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [overflow, setOverflow] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState<{ code: string; name: string; kind: string } | null>(null);

  const zones = useApi<Page<Zone>>(code ? () => api.get<Page<Zone>>("/v1/zones", { warehouse: code }) : null, [code]);
  const locations = useApi<Page<Location>>(
    code ? () => api.get<Page<Location>>("/v1/locations", { warehouse: code, zone: zoneFilter }) : null,
    [code, zoneFilter],
  );
  const holding = useApi<StockAtShelf>(
    selected ? () => api.get<StockAtShelf>(`/v1/locations/${encodeURIComponent(selected.wms_id)}/stock`) : null,
    [selected?.wms_id],
  );
  const save = useAction();
  const addZone = useAction();

  const canPrint = can("printing:write");
  const [printer, setPrinter] = useState(readPrinter);
  const [printAll, setPrintAll] = useState(false);
  const [printOne, setPrintOne] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printed, setPrinted] = useState<{ where: "main" | "panel"; tone: "ok" | "gold"; text: string } | null>(null);

  // Forget the selection when the warehouse changes.
  useEffect(() => { setSelected(null); setAdding(false); setDraft(null); setZoneFilter(null); }, [code]);

  const zoneList = zones.data?.items ?? [];
  const zoneByCode = useMemo(() => new Map(zoneList.map((z) => [z.code, z])), [zoneList]);
  const draftZoneKind = draft ? zoneByCode.get(draft.zone)?.kind : undefined;

  const rows = useMemo(() => {
    const all = locations.data?.items ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((l) => l.code.toLowerCase().includes(q) || l.zone.toLowerCase().includes(q)) : all;
  }, [locations.data, search]);

  function open(l: Location) {
    setSelected(l); setAdding(false); setDraft(draftOf(l)); setOverflow(true); setSaved(null); save.clear();
  }
  function startAdd() {
    setSelected(null); setAdding(true); setDraft(emptyDraft(zoneFilter ?? zoneList[0]?.code ?? "")); setOverflow(true); setSaved(null); save.clear();
  }
  function patch(p: Partial<Draft>) { setDraft((d) => (d ? { ...d, ...p } : d)); }

  async function onSave() {
    if (!draft || !code) return;
    const body = {
      warehouse: code,
      code: draft.code.trim(),
      zone: draft.zone,
      type: draft.type,
      access: draft.access,
      mixing: draft.mixing,
      pick_sequence: draft.pick_sequence.trim() === "" ? 0 : Number(draft.pick_sequence),
      capacity: draft.capacity.trim() === "" ? null : draft.capacity.trim(),
      capacity_uom: draft.capacity_uom.trim() === "" ? null : draft.capacity_uom.trim().toUpperCase(),
      barcode: draft.barcode.trim() === "" ? null : draft.barcode.trim(),
      active: true,
    };
    const reply = await save.run(() => api.message<{ wms_id: string; status: string }>("/v1/locations", body));
    if (!reply) return;
    setSaved(reply.status === "created" ? `Added ${body.code}.` : `Saved ${body.code}.`);
    const page = await api.get<Page<Location>>("/v1/locations", { warehouse: code, zone: zoneFilter });
    locations.setData(page);
    const fresh = page.items.find((l) => l.code === body.code) ?? null;
    if (fresh) { setSelected(fresh); setAdding(false); setDraft(draftOf(fresh)); }
  }

  async function onAddZone() {
    if (!zoneForm || !code) return;
    const body = { warehouse: code, code: zoneForm.code.trim().toUpperCase(), name: zoneForm.name.trim(), kind: zoneForm.kind };
    const reply = await addZone.run(() => api.message("/v1/zones", body));
    if (!reply) return;
    setZoneForm(null);
    await zones.reload();
    if (draft && !draft.zone) patch({ zone: body.code });
  }

  /** One location-label job per shelf. A refusal is counted, never hidden. */
  async function sendLabels(codes: string[], where: "main" | "panel") {
    const name = printer.trim();
    if (!name || !code || codes.length === 0) return;
    rememberPrinter(name);
    setPrintBusy(true);
    setPrinted(null);
    let sent = 0;
    let firstFailure: string | null = null;
    for (const ref of codes) {
      try {
        await api.message("/v1/print-jobs", {
          warehouse: code, template: "location-label", printer: name, copies: 1,
          reference: { type: "location", ref },
        });
        sent += 1;
      } catch (e) {
        if (!firstFailure) firstFailure = e instanceof ApiError ? e.message : "Could not reach the WMS";
      }
    }
    const failed = codes.length - sent;
    setPrintBusy(false);
    setPrintAll(false);
    setPrintOne(false);
    setPrinted({
      where,
      tone: failed > 0 ? "gold" : "ok",
      text: failed > 0
        ? `Sent ${plural(sent, "label")} to ${name}. ${plural(failed, "label")} failed: ${firstFailure}`
        : `Sent ${plural(sent, "label")} to ${name}.`,
    });
  }

  const columns: Column<Location>[] = [
    { key: "code", header: "Location", width: "150px", render: (l) => <b>{l.code}</b> },
    { key: "zone", header: "Zone", width: "110px", render: (l) => l.zone },
    { key: "type", header: "Type", width: "110px", render: (l) => TYPE_LABEL[l.type] ?? l.type },
    { key: "seq", header: "Pick seq", width: "80px", render: (l) => l.pick_sequence ? l.pick_sequence : <Muted>—</Muted> },
    { key: "access", header: "Allows", width: "90px", render: (l) => ACCESS_LABEL[l.access] ?? l.access },
    { key: "mixing", header: "Mixing", width: "120px", render: (l) => mixingLabel(l.mixing) },
    { key: "capacity", header: "Capacity", width: "110px", render: (l) => capacityLabel(l) },
    {
      key: "holding", header: "Holding",
      render: (l) => {
        if (selected?.wms_id !== l.wms_id) return <Muted>—</Muted>;
        if (holding.loading) return <Muted>Loading…</Muted>;
        if (holding.data) return holdingLabel(holding.data);
        return <Muted>—</Muted>;
      },
    },
  ];

  const panelOpen = draft !== null;

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={warehouse ? `${warehouse.name} · ${warehouse.code}` : "Locations"}
          accent="Locations"
          title="and zones"
          actions={<>
            {canPrint && (
              <Button
                onClick={() => { setPrintAll((v) => !v); setPrintOne(false); setPrinted(null); }}
                disabled={!code || rows.length === 0}
                title={code && rows.length === 0 ? "No locations listed to print" : undefined}
              >
                Print location labels
              </Button>
            )}
            {writable && <Button variant="primary" onClick={startAdd} disabled={!code}>Add location</Button>}
          </>}
        />

        <div className="flex gap-3 items-center flex-wrap">
          <SearchInput
            className="w-[300px]"
            placeholder="Find a location"
            aria-label="Find a location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center gap-1 flex-wrap">
            <Chip active={zoneFilter === null} onClick={() => setZoneFilter(null)}>All zones</Chip>
            {zoneList.map((z) => (
              <Chip key={z.code} active={zoneFilter === z.code} onClick={() => setZoneFilter(z.code)}>{z.code}</Chip>
            ))}
            {writable && code && <Chip active={zoneForm !== null} onClick={() => setZoneForm(zoneForm ? null : { code: "", name: "", kind: "bulk" })}>Add zone</Chip>}
          </div>
        </div>

        {zoneForm && (
          <form
            className="card p-4 flex gap-3 items-end flex-wrap"
            onSubmit={(e) => { e.preventDefault(); void onAddZone(); }}
          >
            <Field label="Zone code" error={addZone.fieldErrors.code} className="w-[140px]">
              <Input value={zoneForm.code} onChange={(e) => setZoneForm({ ...zoneForm, code: e.target.value })} placeholder="PICKFACE" autoFocus />
            </Field>
            <Field label="Name" error={addZone.fieldErrors.name} className="w-[200px]">
              <Input value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} placeholder="Pick face" />
            </Field>
            <Field label="Kind" error={addZone.fieldErrors.kind} className="w-[150px]">
              <Select value={zoneForm.kind} onChange={(e) => setZoneForm({ ...zoneForm, kind: e.target.value })}>
                {ZONE_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={addZone.busy || !zoneForm.code.trim() || !zoneForm.name.trim()}>Add zone</Button>
            <Button type="button" onClick={() => setZoneForm(null)}>Cancel</Button>
            {addZone.error && Object.keys(addZone.fieldErrors).length === 0 && <Notice tone="gold">{addZone.error}</Notice>}
          </form>
        )}

        {canPrint && printAll && (
          <form
            className="card p-4 flex gap-3 items-end flex-wrap"
            onSubmit={(e) => { e.preventDefault(); void sendLabels(rows.map((l) => l.code), "main"); }}
          >
            <Field label="Printer" className="w-[220px]">
              <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" autoFocus />
            </Field>
            <Button type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
              {printBusy ? "Printing…" : "Print"}
            </Button>
            <Button type="button" onClick={() => setPrintAll(false)}>Cancel</Button>
            <Muted className="text-sm">{plural(rows.length, "label")} · one job each</Muted>
          </form>
        )}
        {printed?.where === "main" && <Notice tone={printed.tone}>{printed.text}</Notice>}

        {zones.error && <Notice tone="gold">{zones.error}</Notice>}
        {locations.error && <Notice tone="gold">{locations.error}</Notice>}
        {!code && <Muted className="text-sm">No warehouse yet. Add one in Settings before adding locations.</Muted>}
        {code && locations.loading && !locations.data && <Muted className="text-sm">Loading…</Muted>}
        {code && (locations.data || !locations.loading) && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(l) => l.wms_id}
            onRowClick={open}
            selectedKey={selected?.wms_id ?? null}
            empty={
              search.trim()
                ? `No location matches "${search.trim()}".`
                : zoneFilter
                  ? `No locations in ${zoneFilter} yet. Add one and give it a pick sequence.`
                  : "No locations yet. Add a zone, then the shelves, docks and floor spots inside it."
            }
          />
        )}
      </Main>

      <DetailPanel
        footer={panelOpen ? <>
          {canPrint && selected && (
            <Button onClick={() => { setPrintOne((v) => !v); setPrintAll(false); setPrinted(null); }}>Print label</Button>
          )}
          {writable && (
            <Button variant="primary" onClick={() => void onSave()} disabled={save.busy || !draft?.code.trim() || !draft?.zone}>
              {save.busy ? "Saving…" : "Save"}
            </Button>
          )}
        </> : undefined}
      >
        {draft ? (
          <>
            <DetailHeader
              eyebrow="Location"
              title={adding ? "New location" : draft.code}
              subtitle={adding
                ? "A shelf, rack, dock or floor spot the scanner can read."
                : `${zoneByCode.get(draft.zone)?.name ?? draft.zone}${draft.pick_sequence ? ` · pick seq ${draft.pick_sequence}` : ""}`}
            />
            {save.error && Object.keys(save.fieldErrors).length === 0 && <Notice tone="gold">{save.error}</Notice>}
            {saved && <Notice>{saved}</Notice>}
            {printed?.where === "panel" && <Notice tone={printed.tone}>{printed.text}</Notice>}
            {canPrint && printOne && selected && (
              <form
                className="flex flex-col gap-3 rounded-md border border-line p-3"
                onSubmit={(e) => { e.preventDefault(); void sendLabels([selected.code], "panel"); }}
              >
                <Field label="Printer">
                  <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" autoFocus />
                </Field>
                <div className="flex gap-2 [&>*]:grow">
                  <Button small type="button" onClick={() => setPrintOne(false)}>Cancel</Button>
                  <Button small type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
                    {printBusy ? "Printing…" : "Print"}
                  </Button>
                </div>
              </form>
            )}

            {adding && (
              <Field label="Code" error={save.fieldErrors.code} hint="Unique in this warehouse. Sets the label text.">
                <Input value={draft.code} onChange={(e) => patch({ code: e.target.value.toUpperCase() })} placeholder="PF-01-02-A" autoFocus disabled={!writable} />
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Zone" error={save.fieldErrors.zone}>
                <Select value={draft.zone} onChange={(e) => patch({ zone: e.target.value })} disabled={!writable}>
                  {!draft.zone && <option value="">Choose a zone</option>}
                  {zoneList.map((z) => <option key={z.code} value={z.code}>{z.code}</option>)}
                </Select>
              </Field>
              <Field label="Pick sequence" error={save.fieldErrors.pick_sequence}>
                <Input inputMode="numeric" value={draft.pick_sequence} onChange={(e) => patch({ pick_sequence: e.target.value })} placeholder="0" disabled={!writable} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Type" error={save.fieldErrors.type}>
                <Select value={draft.type} onChange={(e) => patch({ type: e.target.value as LocType })} disabled={!writable}>
                  {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </Select>
              </Field>
              <Field label="Access" error={save.fieldErrors.access}>
                <div className="h-10 flex items-center">
                  <SegmentedChoice<Access>
                    value={draft.access}
                    options={(["ground", "step", "forklift"] as Access[]).map((a) => ({ value: a, label: ACCESS_LABEL[a] }))}
                    onChange={(a) => patch({ access: a })}
                    disabled={!writable}
                  />
                </div>
              </Field>
            </div>

            <Section title="Rules">
              <div className="flex flex-col">
                <Toggle
                  label="One product only"
                  hint="No mixing on this shelf"
                  checked={draft.mixing !== "mixed"}
                  onChange={(v) => patch({ mixing: v ? "single_sku" : "mixed" })}
                  disabled={!writable}
                />
                <Toggle label="Counts in FIFO" hint="Received date decides pick order" checked disabled />
                <Toggle
                  label="Allow overflow"
                  hint={draftZoneKind === "overflow" ? "Put away here when the preferred zone is full" : "Only for a zone of kind overflow"}
                  checked={draftZoneKind === "overflow" && overflow}
                  onChange={setOverflow}
                  disabled={draftZoneKind !== "overflow" || !writable}
                />
              </div>
              {save.fieldErrors.mixing && <span className="text-xs leading-4 text-gold">{save.fieldErrors.mixing}</span>}
            </Section>

            <Field label="Barcode" error={save.fieldErrors.barcode} hint="Code 128 · template location-label v2">
              <Input className="mono" value={draft.barcode} onChange={(e) => patch({ barcode: e.target.value })} placeholder={draft.code ? `LOC-${draft.code}` : "LOC-…"} disabled={!writable} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Capacity" error={save.fieldErrors.capacity}>
                <Input inputMode="decimal" value={draft.capacity} onChange={(e) => patch({ capacity: e.target.value })} placeholder="—" disabled={!writable} />
              </Field>
              <Field label="Capacity unit" error={save.fieldErrors.capacity_uom}>
                <Input value={draft.capacity_uom} onChange={(e) => patch({ capacity_uom: e.target.value })} placeholder="PALLET" disabled={!writable} />
              </Field>
            </div>

            {selected && (
              <Section title="Holding">
                {holding.loading && <Muted className="text-sm">Loading…</Muted>}
                {holding.error && <Notice tone="gold">{holding.error}</Notice>}
                {holding.data && holding.data.stock.length === 0 && <Muted className="text-sm">Empty.</Muted>}
                {holding.data && holding.data.stock.length > 0 && (
                  <div className="flex flex-col rounded-lg border border-line">
                    {holding.data.stock.map((s) => (
                      <div key={`${s.sku}/${s.batch ?? ""}/${s.owner}`} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                        <span className="truncate"><b>{s.sku}</b> <Muted>{s.name}{s.batch ? ` · ${s.batch}` : ""}</Muted></span>
                        <span className="shrink-0">{fmtQty(s.on_hand, s.uom)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}
          </>
        ) : (
          <DetailHeader eyebrow="Location" title="—" subtitle={writable ? "Pick a row to edit it, or add a location." : "Pick a row to see its rules and what it holds."} />
        )}
      </DetailPanel>
    </>
  );
}
