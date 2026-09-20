import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Accepted, Container, ContainerChild, ContainerType, Page } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  SearchInput, Section, StatTile, Table, Toggle, type Column,
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

const TYPE_LABEL: Record<ContainerType, string> = {
  pallet: "Pallet", carton: "Carton", tote: "Tote", cage: "Cage",
};
const TYPE_CHIPS: { value: ContainerType; label: string }[] = [
  { value: "pallet", label: "Pallets" },
  { value: "carton", label: "Cartons" },
  { value: "tote", label: "Totes" },
  { value: "cage", label: "Cages" },
];

type Status = Container["status"];
const STATUS: Record<Status, { tone: "ok" | "warn" | "muted" | "info"; label: string }> = {
  open: { tone: "info", label: "Open" },
  closed: { tone: "muted", label: "Closed" },
  shipped: { tone: "ok", label: "Shipped" },
  retired: { tone: "muted", label: "Retired" },
};

const MOVE_REASONS: { value: string; label: string }[] = [
  { value: "tidy", label: "Tidy" },
  { value: "consolidate", label: "Consolidate" },
  { value: "damaged", label: "Damaged" },
  { value: "quality_hold", label: "Quality hold" },
];

function statusPill(status: string) {
  const s = STATUS[status as Status] ?? { tone: "muted" as const, label: status };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

/** Lists come back as a page; be kind if a plain array turns up. */
function items<T>(d: Page<T> | T[] | null): T[] {
  if (!d) return [];
  return Array.isArray(d) ? d : d.items ?? [];
}

interface MoveReply extends Accepted { moved?: string; uom?: string }

/** The new-container form. Strings throughout so the inputs stay controlled. */
interface Draft {
  type: ContainerType;
  container_id: string;
  location: string;
  parent: string;
  assign_sscc: boolean;
  weight_kg: string;
}
function emptyDraft(): Draft {
  return { type: "pallet", container_id: "", location: "", parent: "", assign_sscc: false, weight_kg: "" };
}

type Form = "none" | "move" | "nest";
type Note = { tone: "ok" | "gold" | "muted"; text: ReactNode } | null;

export function Containers() {
  const { warehouse, can } = useAuth();
  const code = warehouse?.code;
  const writable = can("stock:write");

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<ContainerType | null>(null);
  const [topOnly, setTopOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [form, setForm] = useState<Form>("none");
  const [toLocation, setToLocation] = useState("");
  const [reason, setReason] = useState("tidy");
  const [parentCode, setParentCode] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const list = useApi<Page<Container>>(
    code ? () => api.get<Page<Container>>("/v1/containers", { warehouse: code, limit: 500, nested: topOnly ? false : undefined }) : null,
    [code, topOnly],
  );
  const detail = useApi<Container>(
    selected ? () => api.get<Container>(`/v1/containers/${encodeURIComponent(selected)}`) : null,
    [selected],
  );
  const act = useAction();
  const create = useAction();

  // Forget the selection when the warehouse changes.
  useEffect(() => { setSelected(null); setAdding(false); setNote(null); }, [code]);

  const [printer, setPrinter] = useState(readPrinter);
  const [printWhere, setPrintWhere] = useState<"none" | "main" | "panel">("none");
  const [printBusy, setPrintBusy] = useState(false);
  const [printed, setPrinted] = useState<{ where: "main" | "panel"; tone: "ok" | "gold"; text: string } | null>(null);

  const all = useMemo(() => items(list.data), [list.data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (typeFilter && c.type !== typeFilter) return false;
      if (!q) return true;
      return c.container_id.toLowerCase().includes(q) || (c.sscc ?? "").toLowerCase().includes(q);
    });
  }, [all, search, typeFilter]);

  const counts = useMemo(() => ({
    pallet: all.filter((c) => c.type === "pallet").length,
    carton: all.filter((c) => c.type === "carton").length,
    tote: all.filter((c) => c.type === "tote").length,
    closed: all.filter((c) => c.status === "closed").length,
  }), [all]);

  const open = detail.data;

  function select(c: Container) {
    setSelected(c.container_id);
    setAdding(false);
    setForm("none");
    setNote(null);
    setToLocation("");
    setParentCode("");
    act.clear();
  }
  function startAdd() {
    setSelected(null);
    setAdding(true);
    setDraft(emptyDraft());
    setForm("none");
    setNote(null);
    create.clear();
  }
  function patch(p: Partial<Draft>) { setDraft((d) => ({ ...d, ...p })); }

  async function refresh() {
    await Promise.all([list.reload(), detail.reload()]);
  }

  async function post<T>(what: string, path: string, body: Record<string, unknown>): Promise<T | undefined> {
    setLastAction(what);
    return act.run(() => api.message<T>(path, body));
  }

  async function onMove(e: FormEvent) {
    e.preventDefault();
    if (!open || !toLocation.trim()) return;
    const to = toLocation.trim().toUpperCase();
    const reply = await post<MoveReply>("move", `/v1/containers/${encodeURIComponent(open.container_id)}/move`, { to_location: to, reason });
    if (!reply) return;
    setForm("none");
    setToLocation("");
    setNote({ tone: "ok", text: `Moved ${fmtQty(reply.moved ?? "0", reply.uom)} to ${to}.` });
    await refresh();
  }

  async function onNest(e: FormEvent) {
    e.preventDefault();
    if (!open || !parentCode.trim()) return;
    const parent = parentCode.trim().toUpperCase();
    const reply = await post("nest", `/v1/containers/${encodeURIComponent(open.container_id)}/nest`, { parent });
    if (!reply) return;
    setForm("none");
    setParentCode("");
    setNote({ tone: "muted", text: `${open.container_id} is on ${parent}.` });
    await refresh();
  }

  async function onUnnest(child: ContainerChild) {
    const reply = await post("unnest", `/v1/containers/${encodeURIComponent(child.container_id)}/unnest`, {});
    if (!reply) return;
    setNote({ tone: "muted", text: `${child.container_id} is off.` });
    await refresh();
  }

  async function onAssignSscc() {
    if (!open || !code) return;
    const reply = await post("sscc", `/v1/containers`, {
      warehouse: code, container_id: open.container_id, type: open.type, assign_sscc: true,
    });
    if (!reply) return;
    setNote({ tone: "muted", text: `${open.container_id} has an SSCC.` });
    await refresh();
  }

  async function onSeal(path: "close" | "reopen") {
    if (!open) return;
    const reply = await post("seal", `/v1/containers/${encodeURIComponent(open.container_id)}/${path}`, {});
    if (!reply) return;
    setNote({ tone: "muted", text: path === "close" ? `${open.container_id} is sealed.` : `${open.container_id} is open again.` });
    await refresh();
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!code) return;
    const body: Record<string, unknown> = {
      warehouse: code,
      type: draft.type,
      container_id: draft.container_id.trim() === "" ? null : draft.container_id.trim().toUpperCase(),
      location: draft.location.trim() === "" ? null : draft.location.trim().toUpperCase(),
      parent: draft.parent.trim() === "" ? null : draft.parent.trim().toUpperCase(),
      assign_sscc: draft.assign_sscc,
      weight_kg: draft.weight_kg.trim() === "" ? null : draft.weight_kg.trim(),
    };
    const reply = await create.run(() => api.message<Accepted & { container_id?: string }>("/v1/containers", body));
    if (!reply) return;
    const made = reply.container_id ?? (body.container_id as string | null);
    setAdding(false);
    setNote({ tone: "muted", text: made ? `Added ${made}.` : "Added the container." });
    await list.reload();
    if (made) setSelected(made);
  }

  /** One pallet-label job. A refusal is said out loud, never hidden. */
  async function sendLabel(ref: string, where: "main" | "panel") {
    const name = printer.trim();
    if (!name || !code) return;
    rememberPrinter(name);
    setPrintBusy(true);
    setPrinted(null);
    const reply = await act.run(() => api.message("/v1/print-jobs", {
      warehouse: code, template: "pallet-label", printer: name, copies: 1,
      reference: { type: "container", ref },
    }));
    setPrintBusy(false);
    if (reply === undefined) {
      setPrinted({ where, tone: "gold", text: `Could not send the label for ${ref}.` });
      return;
    }
    setPrintWhere("none");
    setPrinted({ where, tone: "ok", text: `Sent 1 pallet label to ${name}.` });
  }

  const columns: Column<Container>[] = [
    { key: "container", header: "Container", width: "180px", render: (c) => <b className="mono">{c.container_id}</b> },
    { key: "type", header: "Type", width: "90px", render: (c) => TYPE_LABEL[c.type] ?? c.type },
    { key: "sscc", header: "SSCC", width: "180px", render: (c) => c.sscc ? <span className="mono">{c.sscc}</span> : <Muted>none</Muted> },
    { key: "location", header: "Location", width: "130px", render: (c) => c.location ?? <Muted>—</Muted> },
    { key: "parent", header: "Inside", width: "140px", render: (c) => c.parent ?? <Muted>—</Muted> },
    {
      key: "children", header: "Holding", width: "120px",
      render: (c) => c.children.length > 0 ? plural(c.children.length, "carton") : <Muted>—</Muted>,
    },
    { key: "status", header: "Status", width: "100px", render: (c) => statusPill(c.status) },
  ];

  return (
    <>
      <Main>
        <PageHeader
          eyebrow={`${warehouse?.name ?? "Containers"} · pallets, cartons and totes`}
          accent="Containers"
          title=""
          actions={<>
            <Button
              onClick={() => { setPrintWhere((w) => (w === "main" ? "none" : "main")); setPrinted(null); }}
              disabled={!selected}
              title={selected ? undefined : "Pick a container first"}
            >
              Print pallet label
            </Button>
            {writable && <Button variant="primary" onClick={startAdd} disabled={!code}>New container</Button>}
          </>}
        />

        <div className="flex gap-3 items-center flex-wrap">
          <SearchInput
            className="w-[300px]"
            placeholder="Find a container or SSCC"
            aria-label="Find a container or SSCC"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center gap-1 flex-wrap">
            <Chip active={typeFilter === null} onClick={() => setTypeFilter(null)}>All</Chip>
            {TYPE_CHIPS.map((t) => (
              <Chip key={t.value} active={typeFilter === t.value} onClick={() => setTypeFilter(t.value)}>{t.label}</Chip>
            ))}
          </div>
          <div className="w-[220px]">
            <Toggle label="Top level only" hint="Hide what is on something" checked={topOnly} onChange={setTopOnly} />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <StatTile label="Pallets" value={counts.pallet} hint="in this warehouse" />
          <StatTile label="Cartons" value={counts.carton} hint="loose and nested" />
          <StatTile label="Totes" value={counts.tote} hint="picking and transfer" />
          <StatTile label="Closed" value={counts.closed} hint="sealed" />
        </div>

        {printWhere === "main" && selected && (
          <form
            className="card p-4 flex gap-3 items-end flex-wrap"
            onSubmit={(e) => { e.preventDefault(); void sendLabel(selected, "main"); }}
          >
            <Field label="Printer" className="w-[220px]">
              <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" autoFocus />
            </Field>
            <Button type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
              {printBusy ? "Printing…" : "Print"}
            </Button>
            <Button type="button" onClick={() => setPrintWhere("none")}>Cancel</Button>
            <Muted className="text-sm">{selected} · one job</Muted>
          </form>
        )}
        {printed?.where === "main" && <Notice tone={printed.tone}>{printed.text}</Notice>}

        {list.error && <Notice tone="gold">{list.error}</Notice>}
        {!code && <Muted className="text-sm">No warehouse yet. Add one in Settings before building pallets.</Muted>}
        {code && list.loading && !list.data && <Muted className="text-sm">Loading…</Muted>}
        {code && (list.data || !list.loading) && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(c) => c.wms_id}
            onRowClick={select}
            selectedKey={rows.find((c) => c.container_id === selected)?.wms_id ?? null}
            empty={
              search.trim()
                ? `No container matches "${search.trim()}".`
                : typeFilter
                  ? `No ${TYPE_CHIPS.find((t) => t.value === typeFilter)?.label.toLowerCase()} here yet.`
                  : "No containers yet. Build a pallet and the scanner can move everything on it with one label."
            }
          />
        )}
      </Main>

      {adding ? (
        <DetailPanel footer={<>
          <Button onClick={() => { setAdding(false); create.clear(); }}>Cancel</Button>
          <Button type="submit" form="new-container" variant="primary" disabled={create.busy}>
            {create.busy ? "Saving…" : "Create"}
          </Button>
        </>}>
          <DetailHeader
            eyebrow="New container"
            title="New container"
            subtitle="A pallet, carton, tote or cage the scanner can read."
          />
          {create.error && Object.keys(create.fieldErrors).length === 0 && <Notice tone="gold">{create.error}</Notice>}
          <form id="new-container" className="flex flex-col gap-3" onSubmit={onCreate}>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs leading-4 text-muted">Type</span>
              <div className="flex gap-1.5 flex-wrap">
                {TYPE_CHIPS.map((t) => (
                  <Chip key={t.value} active={draft.type === t.value} onClick={() => patch({ type: t.value })}>
                    {TYPE_LABEL[t.value]}
                  </Chip>
                ))}
              </div>
              {create.fieldErrors.type && <span className="text-xs leading-4 text-gold">{create.fieldErrors.type}</span>}
            </div>
            <Field label="Code" hint="Leave it blank and the WMS gives one." error={create.fieldErrors.container_id}>
              <Input
                aria-label="Code"
                className="mono"
                value={draft.container_id}
                onChange={(e) => patch({ container_id: e.target.value.toUpperCase() })}
                placeholder="PAL-000123"
                autoFocus
              />
            </Field>
            <Field label="Location" error={create.fieldErrors.location}>
              <Input
                aria-label="Location"
                value={draft.location}
                onChange={(e) => patch({ location: e.target.value.toUpperCase() })}
                placeholder="BK-04-01-C"
              />
            </Field>
            <Field label="Inside" hint="The pallet this one goes on, if any." error={create.fieldErrors.parent}>
              <Input
                aria-label="Inside"
                value={draft.parent}
                onChange={(e) => patch({ parent: e.target.value.toUpperCase() })}
                placeholder="—"
              />
            </Field>
            <Toggle
              label="Give it an SSCC"
              hint="Eighteen digits from the warehouse's GS1 prefix"
              checked={draft.assign_sscc}
              onChange={(v) => patch({ assign_sscc: v })}
            />
            {create.fieldErrors.assign_sscc && <span className="text-xs leading-4 text-gold">{create.fieldErrors.assign_sscc}</span>}
            <Field label="Weight (kg)" error={create.fieldErrors.weight_kg}>
              <Input
                aria-label="Weight (kg)"
                inputMode="decimal"
                value={draft.weight_kg}
                onChange={(e) => patch({ weight_kg: e.target.value })}
                placeholder="—"
              />
            </Field>
          </form>
        </DetailPanel>
      ) : open ? (
        <DetailPanel footer={<>
          {writable && (open.status === "closed"
            ? <Button variant="gold" disabled={act.busy} onClick={() => void onSeal("reopen")}>Reopen</Button>
            : <Button variant="gold" disabled={act.busy || open.status === "shipped"} onClick={() => void onSeal("close")}>Close</Button>)}
          <Button
            variant="primary"
            onClick={() => { setPrintWhere((w) => (w === "panel" ? "none" : "panel")); setPrinted(null); }}
          >
            Print pallet label
          </Button>
        </>}>
          <DetailHeader
            eyebrow={TYPE_LABEL[open.type] ?? open.type}
            title={<span className="mono">{open.container_id}</span>}
            subtitle={open.sscc ? <span className="mono">{open.sscc}</span> : "no SSCC yet"}
          />
          {act.error && <Notice tone="gold">
            {act.error}
            {lastAction === "sscc" && <> <Link to="/settings">Set the GS1 company prefix in Settings.</Link></>}
          </Notice>}
          {note && <Notice tone={note.tone}>{note.text}</Notice>}
          {printed?.where === "panel" && <Notice tone={printed.tone}>{printed.text}</Notice>}
          {detail.error && <Notice tone="gold">{detail.error}</Notice>}

          <KeyValue items={[
            { label: "Warehouse", value: open.warehouse },
            { label: "Location", value: open.location ?? "—" },
            { label: "Inside", value: open.parent ?? "—" },
            { label: "Status", value: (STATUS[open.status] ?? { label: open.status }).label },
            { label: "Weight", value: open.weight_kg ? fmtQty(open.weight_kg, "kg") : "—" },
            { label: "Created", value: fmtWhen(open.created_at) },
          ]} />

          <Section title="What is on it">
            {open.contents.length === 0 ? (
              <Muted className="text-sm">Nothing has been put on it yet.</Muted>
            ) : (
              <div className="flex flex-col rounded-lg border border-line">
                {open.contents.map((c, i) => (
                  <div key={`${c.sku}/${c.batch ?? ""}/${i}`} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                    <span className="truncate">
                      <b>{c.sku}</b> <Muted>· {c.name}</Muted>
                      {c.batch && <Muted> · {c.batch}</Muted>}
                    </span>
                    <span className="shrink-0">{fmtQty(c.qty, c.uom)}</span>
                  </div>
                ))}
                <div className="px-3 py-2 text-xs leading-4 text-muted border-t border-line">
                  {fmtQty(open.total_qty)} in all
                </div>
              </div>
            )}
          </Section>

          <Section title="Holding">
            {open.children.length === 0 ? (
              <Muted className="text-sm">Nothing is on it. Put a carton on it and it follows the pallet.</Muted>
            ) : (
              <div className="flex flex-col rounded-lg border border-line">
                {open.children.map((child) => (
                  <div key={child.container_id} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                    <span className="truncate">
                      <span className="mono">{child.container_id}</span> <Muted>· {TYPE_LABEL[child.type] ?? child.type}</Muted>
                    </span>
                    <span className="shrink-0 flex items-center gap-2">
                      {statusPill(child.status)}
                      {writable && (
                        <Button small disabled={act.busy} onClick={() => void onUnnest(child)}>Take off</Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {writable && (
            <div className="flex gap-2 flex-wrap">
              <Button small onClick={() => { setForm(form === "move" ? "none" : "move"); setNote(null); act.clear(); }}>Move it</Button>
              <Button small onClick={() => { setForm(form === "nest" ? "none" : "nest"); setNote(null); act.clear(); }}>Put it on</Button>
              {open.sscc === null && (
                <Button small disabled={act.busy} onClick={() => void onAssignSscc()}>Give it an SSCC</Button>
              )}
            </div>
          )}

          {writable && form === "move" && (
            <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={onMove}>
              <Field label="To location" error={act.fieldErrors.to_location}>
                <Input
                  aria-label="To location"
                  value={toLocation}
                  onChange={(e) => setToLocation(e.target.value.toUpperCase())}
                  placeholder="STAGE-01"
                  autoFocus
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs leading-4 text-muted">Why</span>
                <div className="flex gap-1.5 flex-wrap">
                  {MOVE_REASONS.map((r) => (
                    <Chip key={r.value} active={reason === r.value} onClick={() => setReason(r.value)}>{r.label}</Chip>
                  ))}
                </div>
                {act.fieldErrors.reason && <span className="text-xs leading-4 text-gold">{act.fieldErrors.reason}</span>}
              </div>
              <Muted className="text-xs leading-4">Everything on it moves too, nested cartons included.</Muted>
              <div className="flex gap-2 [&>*]:grow">
                <Button small type="button" onClick={() => setForm("none")}>Cancel</Button>
                <Button small type="submit" variant="primary" disabled={act.busy || !toLocation.trim()}>
                  {act.busy ? "Moving…" : "Move"}
                </Button>
              </div>
            </form>
          )}

          {writable && form === "nest" && (
            <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={onNest}>
              <Field label="Pallet" hint="It takes that pallet's location and follows it." error={act.fieldErrors.parent}>
                <Input
                  aria-label="Pallet"
                  className="mono"
                  value={parentCode}
                  onChange={(e) => setParentCode(e.target.value.toUpperCase())}
                  placeholder="PAL-000123"
                  autoFocus
                />
              </Field>
              <div className="flex gap-2 [&>*]:grow">
                <Button small type="button" onClick={() => setForm("none")}>Cancel</Button>
                <Button small type="submit" variant="primary" disabled={act.busy || !parentCode.trim()}>
                  {act.busy ? "Saving…" : "Put on"}
                </Button>
              </div>
            </form>
          )}

          {printWhere === "panel" && (
            <form
              className="flex flex-col gap-3 rounded-lg border border-line p-3"
              onSubmit={(e) => { e.preventDefault(); void sendLabel(open.container_id, "panel"); }}
            >
              <Field label="Printer">
                <Input value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Office" autoFocus />
              </Field>
              <div className="flex gap-2 [&>*]:grow">
                <Button small type="button" onClick={() => setPrintWhere("none")}>Cancel</Button>
                <Button small type="submit" variant="primary" disabled={printBusy || !printer.trim()}>
                  {printBusy ? "Printing…" : "Print"}
                </Button>
              </div>
            </form>
          )}
        </DetailPanel>
      ) : (
        <DetailPanel>
          <DetailHeader
            eyebrow="Container"
            title="—"
            subtitle={selected && detail.loading ? "Loading…" : "Pick a pallet to see what is on it and where it goes."}
          />
          {detail.error && <Notice tone="gold">{detail.error}</Notice>}
          {note && <Notice tone={note.tone}>{note.text}</Notice>}
        </DetailPanel>
      )}
    </>
  );
}
