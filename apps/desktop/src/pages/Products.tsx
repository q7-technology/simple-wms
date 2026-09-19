import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Barcode, Page, Product, StockBySku } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, Muted, Notice, PageHeader, SearchInput,
  Section, SegmentedChoice, Select, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

const OWNER = "DEFAULT";
const UNITS = ["EA", "KG", "L", "M", "CTN"];
const ZONES = ["PICKFACE", "BULK", "LINE-SIDE"];
type Kind = Barcode["kind"];
const KIND_LABEL: Record<Kind, string> = { gtin: "GTIN · GS1", carton: "Carton", supplier: "Supplier label", other: "Other" };
const KINDS: Kind[] = ["gtin", "carton", "supplier", "other"];
type Filter = "all" | "batch" | "nobarcode";

function barcodesLabel(p: Product): string {
  if (p.barcodes.length === 0) return "None";
  const first = p.barcodes[0].kind.toUpperCase();
  const extra = p.barcodes.length - 1;
  return extra > 0 ? `${first} + ${extra}` : first;
}

function minMax(p: Product): string {
  return `${p.pickface_min ? fmtQty(p.pickface_min) : "—"} / ${p.pickface_max ? fmtQty(p.pickface_max) : "—"}`;
}

function kindLabel(b: Barcode): string {
  if (b.kind === "carton") return Number(b.qty_per) > 1 ? `Carton of ${fmtQty(b.qty_per)}` : "Carton";
  return KIND_LABEL[b.kind] ?? b.kind;
}

/** The form's view of a product. Strings throughout so the inputs stay controlled. */
interface Draft {
  sku: string;
  name: string;
  uom: string;
  preferred_zone: string;
  pickface_min: string;
  pickface_max: string;
  batch_tracked: boolean;
  decimals_allowed: boolean;
  barcodes: Barcode[];
}

function emptyDraft(): Draft {
  return { sku: "", name: "", uom: "EA", preferred_zone: "", pickface_min: "", pickface_max: "", batch_tracked: false, decimals_allowed: false, barcodes: [] };
}

function draftOf(p: Product): Draft {
  return {
    sku: p.sku, name: p.name, uom: p.uom, preferred_zone: p.preferred_zone ?? "",
    pickface_min: p.pickface_min ?? "", pickface_max: p.pickface_max ?? "",
    batch_tracked: p.batch_tracked, decimals_allowed: p.decimals_allowed,
    barcodes: p.barcodes.map((b) => ({ ...b })),
  };
}

export function Products() {
  const { warehouse, can } = useAuth();
  const writable = can("master:write");

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newBarcode, setNewBarcode] = useState<{ barcode: string; kind: Kind; qty_per: string } | null>(null);

  const products = useApi<Page<Product>>(() => api.get<Page<Product>>("/v1/products", { q: q.trim(), owner: OWNER }), [q]);
  const onHand = useApi<StockBySku>(
    selected ? () => api.get<StockBySku>("/v1/stock", { sku: selected.sku, owner: OWNER }) : null,
    [selected?.sku],
  );
  const save = useAction();

  useEffect(() => { setSaved(null); }, [selected?.sku, adding]);

  const rows = useMemo(() => {
    const all = products.data?.items ?? [];
    if (filter === "batch") return all.filter((p) => p.batch_tracked);
    if (filter === "nobarcode") return all.filter((p) => p.barcodes.length === 0);
    return all;
  }, [products.data, filter]);

  function open(p: Product) {
    setSelected(p); setAdding(false); setDraft(draftOf(p)); setNewBarcode(null); save.clear();
  }
  function startAdd() {
    setSelected(null); setAdding(true); setDraft(emptyDraft()); setNewBarcode(null); save.clear();
  }
  function patch(p: Partial<Draft>) { setDraft((d) => (d ? { ...d, ...p } : d)); }

  function addBarcode() {
    if (!draft || !newBarcode || !newBarcode.barcode.trim()) return;
    const qty = newBarcode.qty_per.trim() === "" ? "1" : newBarcode.qty_per.trim();
    patch({ barcodes: [...draft.barcodes, { barcode: newBarcode.barcode.trim(), kind: newBarcode.kind, qty_per: qty }] });
    setNewBarcode(null);
  }

  async function onSave() {
    if (!draft) return;
    const body = {
      owner: OWNER,
      sku: draft.sku.trim(),
      name: draft.name.trim(),
      uom: draft.uom,
      decimals_allowed: draft.decimals_allowed,
      batch_tracked: draft.batch_tracked,
      preferred_zone: draft.preferred_zone || null,
      pickface_min: draft.pickface_min.trim() === "" ? null : draft.pickface_min.trim(),
      pickface_max: draft.pickface_max.trim() === "" ? null : draft.pickface_max.trim(),
      barcodes: draft.barcodes.map((b) => ({ barcode: b.barcode, kind: b.kind, qty_per: b.qty_per })),
      active: true,
    };
    const reply = await save.run(() => api.message<{ wms_id: string; status: string }>("/v1/products", body));
    if (!reply) return;
    setSaved(reply.status === "created" ? `Added ${body.sku}.` : `Saved ${body.sku}.`);
    const page = await api.get<Page<Product>>("/v1/products", { q: q.trim(), owner: OWNER });
    products.setData(page);
    const fresh = page.items.find((p) => p.sku === body.sku) ?? null;
    if (fresh) { setSelected(fresh); setAdding(false); setDraft(draftOf(fresh)); }
  }

  const columns: Column<Product>[] = [
    { key: "sku", header: "SKU", width: "120px", render: (p) => <b>{p.sku}</b> },
    { key: "name", header: "Name", render: (p) => p.name },
    { key: "uom", header: "Unit", width: "70px", render: (p) => p.uom },
    { key: "batch", header: "Batch", width: "70px", render: (p) => (p.batch_tracked ? "Yes" : "No") },
    { key: "zone", header: "Zone", width: "110px", render: (p) => p.preferred_zone ?? <Muted>—</Muted> },
    { key: "minmax", header: "Min / max", width: "100px", render: (p) => minMax(p) },
    { key: "barcodes", header: "Barcodes", width: "110px", render: (p) => (p.barcodes.length ? barcodesLabel(p) : <Muted>None</Muted>) },
    {
      key: "onhand", header: "On hand", width: "160px",
      render: (p) => {
        if (selected?.sku !== p.sku) return <Muted>—</Muted>;
        if (onHand.loading) return <Muted>Loading…</Muted>;
        if (!onHand.data) return <Muted>—</Muted>;
        const warehouses = new Set(onHand.data.locations.map((l) => l.warehouse)).size;
        return `${fmtQty(onHand.data.total_on_hand, onHand.data.uom)}${warehouses > 1 ? ` · ${plural(warehouses, "warehouse")}` : ""}`;
      },
    },
  ];

  const panelOpen = draft !== null;
  const generalError = save.error && Object.keys(save.fieldErrors).length === 0 ? save.error : null;

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="Master data"
          accent="Products"
          title=""
          actions={<>
            <Button variant="gold" disabled title="Comes with step 2">Import CSV</Button>
            {writable && <Button variant="primary" onClick={startAdd}>Add product</Button>}
          </>}
        />

        <div className="flex gap-3 items-center flex-wrap">
          <SearchInput
            className="w-[300px]"
            placeholder="SKU or name"
            aria-label="Find a product"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex items-center gap-1 flex-wrap">
            <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
            <Chip active={filter === "batch"} onClick={() => setFilter("batch")}>Batch tracked</Chip>
            <span title="Needs a stock lookup per product; comes with replenishment (step 2)" className="opacity-50 cursor-not-allowed">
              <Chip>Below min</Chip>
            </span>
            <Chip active={filter === "nobarcode"} onClick={() => setFilter("nobarcode")}>No barcode</Chip>
            <span title="One owner for now; switched on in step 6"><Chip active>Owner: {OWNER}</Chip></span>
          </div>
        </div>

        {products.error && <Notice tone="gold">{products.error}</Notice>}
        {products.loading && !products.data && <Muted className="text-sm">Loading…</Muted>}
        {(products.data || !products.loading) && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(p) => p.sku}
            onRowClick={open}
            selectedKey={selected?.sku ?? null}
            empty={
              q.trim()
                ? `No product matches "${q.trim()}".`
                : filter === "batch"
                  ? "No batch tracked products. Switch batch tracking on in a product to see it here."
                  : filter === "nobarcode"
                    ? "Every product has at least one barcode."
                    : "No products yet. Add one, or import a CSV once step 2 lands."
            }
          />
        )}
      </Main>

      <DetailPanel
        footer={panelOpen ? <>
          <Button disabled title="Printing comes with step 4">Print product label</Button>
          {writable && (
            <Button variant="primary" onClick={() => void onSave()} disabled={save.busy || !draft?.sku.trim() || !draft?.name.trim()}>
              {save.busy ? "Saving…" : "Save"}
            </Button>
          )}
        </> : undefined}
      >
        {draft ? (
          <>
            <DetailHeader
              eyebrow="Product"
              title={adding ? "New product" : draft.sku}
              subtitle={adding ? `Owner ${OWNER}${warehouse ? ` · shared across warehouses` : ""}` : `${draft.name} · owner ${OWNER}`}
            />
            {generalError && <Notice tone="gold">{generalError}</Notice>}
            {saved && <Notice>{saved}</Notice>}

            <Field label="SKU" error={save.fieldErrors.sku} hint={adding ? "Unique per owner. Cannot change once saved." : undefined}>
              <Input value={draft.sku} onChange={(e) => patch({ sku: e.target.value })} readOnly={!adding} disabled={!writable} placeholder="ABC123" autoFocus={adding} />
            </Field>
            <Field label="Name" error={save.fieldErrors.name}>
              <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} disabled={!writable} placeholder="Brake pad set" />
            </Field>

            <Field label="Unit" error={save.fieldErrors.uom}>
              <SegmentedChoice
                value={draft.uom}
                options={(UNITS.includes(draft.uom) ? UNITS : [...UNITS, draft.uom]).map((u) => ({ value: u, label: u }))}
                onChange={(u) => patch({ uom: u })}
                disabled={!writable}
              />
            </Field>
            <Field label="Preferred zone" error={save.fieldErrors.preferred_zone}>
              <SegmentedChoice
                value={draft.preferred_zone}
                options={[
                  ...(ZONES.includes(draft.preferred_zone) || !draft.preferred_zone ? ZONES : [...ZONES, draft.preferred_zone]).map((z) => ({ value: z, label: z })),
                  { value: "", label: "None" },
                ]}
                onChange={(z) => patch({ preferred_zone: z })}
                disabled={!writable}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Min at pick face" error={save.fieldErrors.pickface_min}>
                <Input inputMode="decimal" value={draft.pickface_min} onChange={(e) => patch({ pickface_min: e.target.value })} placeholder="—" disabled={!writable} />
              </Field>
              <Field label="Max at pick face" error={save.fieldErrors.pickface_max}>
                <Input inputMode="decimal" value={draft.pickface_max} onChange={(e) => patch({ pickface_max: e.target.value })} placeholder="—" disabled={!writable} />
              </Field>
            </div>

            <div className="flex flex-col">
              <Toggle
                label="Batch / lot tracking"
                hint="Every receipt and pick asks for a batch"
                checked={draft.batch_tracked}
                onChange={(v) => patch({ batch_tracked: v })}
                disabled={!writable}
              />
              <Toggle
                label="Decimal quantities"
                hint="Off for a countable item"
                checked={draft.decimals_allowed}
                onChange={(v) => patch({ decimals_allowed: v })}
                disabled={!writable}
              />
            </div>

            <Section
              title="Barcodes"
              action={writable && !newBarcode ? (
                <Button small onClick={() => setNewBarcode({ barcode: "", kind: "gtin", qty_per: "" })}>Add barcode</Button>
              ) : undefined}
            >
              {draft.barcodes.length === 0 && !newBarcode && (
                <Muted className="text-sm">No barcodes. The scanner will only find this product by SKU.</Muted>
              )}
              {draft.barcodes.length > 0 && (
                <div className="flex flex-col rounded-lg border border-line">
                  {draft.barcodes.map((b, i) => (
                    <div key={`${b.barcode}-${i}`} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                      <span className="flex flex-col min-w-0">
                        <span className="mono truncate">{b.barcode}</span>
                        <Muted className="text-xs leading-4">{kindLabel(b)}</Muted>
                      </span>
                      {writable && (
                        <Button small variant="ghost" aria-label={`Remove ${b.barcode}`} onClick={() => patch({ barcodes: draft.barcodes.filter((_, j) => j !== i) })}>
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {save.fieldErrors.barcodes && <span className="text-xs leading-4 text-gold">{save.fieldErrors.barcodes}</span>}
              {newBarcode && (
                <form className="card p-3 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); addBarcode(); }}>
                  <Field label="Barcode">
                    <Input className="mono" value={newBarcode.barcode} onChange={(e) => setNewBarcode({ ...newBarcode, barcode: e.target.value })} placeholder="09312345000012" autoFocus />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Kind">
                      <Select value={newBarcode.kind} onChange={(e) => setNewBarcode({ ...newBarcode, kind: e.target.value as Kind })}>
                        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </Select>
                    </Field>
                    <Field label="Qty per scan" hint={`in ${draft.uom}`}>
                      <Input inputMode="decimal" value={newBarcode.qty_per} onChange={(e) => setNewBarcode({ ...newBarcode, qty_per: e.target.value })} placeholder="1" />
                    </Field>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button small type="button" onClick={() => setNewBarcode(null)}>Cancel</Button>
                    <Button small type="submit" variant="primary" disabled={!newBarcode.barcode.trim()}>Add</Button>
                  </div>
                </form>
              )}
            </Section>

            {selected && (
              <Section title="On hand">
                {onHand.loading && <Muted className="text-sm">Loading…</Muted>}
                {onHand.error && <Muted className="text-sm">No stock recorded yet.</Muted>}
                {onHand.data && (
                  <div className="text-sm leading-5">
                    {fmtQty(onHand.data.total_on_hand, onHand.data.uom)} on hand · {fmtQty(onHand.data.total_available)} available
                    {onHand.data.locations.length > 0 && <Muted> · {plural(onHand.data.locations.length, "shelf", "shelves")}</Muted>}
                  </div>
                )}
              </Section>
            )}
          </>
        ) : (
          <DetailHeader eyebrow="Product" title="—" subtitle={writable ? "Pick a row to edit it, or add a product." : "Pick a row to see its details."} />
        )}
      </DetailPanel>
    </>
  );
}
