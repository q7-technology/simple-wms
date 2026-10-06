import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type {
  Accepted, BatchSuggestion, Delivery, Page, PickBatch as Batch,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtQty, fmtWhen, plural } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Card, DetailHeader, DetailPanel, Eyebrow, Field, Input, Muted, Notice, Pill, Section,
  StatTile, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

interface SuggestReply { groups: BatchSuggestion[]; max_orders: number }

function statusPill(status: Batch["status"]) {
  switch (status) {
    case "new": return <Pill tone="info">Ready</Pill>;
    case "picking": return <Pill tone="info">Picking</Pill>;
    case "picked": return <Pill tone="ok">Picked</Pill>;
    default: return <Pill tone="muted">Cancelled</Pill>;
  }
}

/* --- the batch panel ----------------------------------------------------- */

function BatchDetail({ batch, write, reload }: {
  batch: Batch; write: boolean; reload: () => Promise<void>;
}) {
  const action = useAction();
  const open = batch.status === "new" || batch.status === "picking";

  const cancel = async () => {
    if (!window.confirm(`Cancel ${batch.external_ref}? Only the grouping goes; every order keeps its task and its stock.`)) return;
    const out = await action.run(() => api.message<Accepted>(
      `/v1/pick-batches/${encodeURIComponent(batch.external_ref)}/cancel`,
      { reason: "cancelled from the desktop" },
    ));
    if (out) await reload();
  };

  return (
    <>
      <DetailHeader
        eyebrow="Pick batch"
        title={batch.external_ref}
        subtitle={`${plural(batch.orders, "order")} · ${plural(batch.lines, "line")} · ${batch.assigned_to ?? "unassigned"}`}
      />
      <Section title="Totes">
        <div className="flex flex-col rounded-lg border border-line">
          {batch.totes.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">No totes on this batch.</div>}
          {batch.totes.map((t) => (
            <div key={t.tote} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">tote {t.tote} → {t.delivery}{t.ship_to ? ` · ${t.ship_to}` : ""} · {t.status}</span>
              <Muted className="shrink-0">{plural(t.lines, "line")}</Muted>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Stops left">
        <div className="flex flex-col rounded-lg border border-line">
          {batch.stops.length === 0 && <div className="px-3 py-2.5 text-sm text-muted">Every stop on this walk is done.</div>}
          {batch.stops.map((s) => (
            <div key={s.stop} className="flex flex-col gap-0.5 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span className="truncate">
                stop {s.stop} · {s.location} · {s.sku} · {fmtQty(s.qty, s.uom)}
              </span>
              <Muted className="text-xs leading-4">
                {s.picks.map((p) => `tote ${p.tote} ${fmtQty(p.qty)}`).join(" · ")}
              </Muted>
            </div>
          ))}
        </div>
      </Section>
      <Muted className="text-xs leading-4">Only the grouping goes; every order keeps its task and its stock.</Muted>
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <div className="grow" />
      <div className="flex gap-2 [&>*]:grow">
        {write && open && (
          <Button variant="gold" onClick={() => void cancel()} disabled={action.busy}>Cancel batch</Button>
        )}
      </div>
    </>
  );
}

/* --- the screen ---------------------------------------------------------- */

export function BatchPick() {
  const { warehouse, can } = useAuth();
  const write = can("tasks:write");
  const [ticked, setTicked] = useState<string[]>([]);
  const [assignedTo, setAssignedTo] = useState("");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const action = useAction();

  const code = warehouse?.code;
  const waiting = useApi<Page<Delivery>>(
    () => api.get<Page<Delivery>>("/v1/deliveries", { warehouse: code, status: "allocated", limit: 500 }),
    [code],
  );
  const suggest = useApi<SuggestReply>(
    () => api.get<SuggestReply>("/v1/pick-batches/suggest", { warehouse: code }),
    [code],
  );
  const batches = useApi<Page<Batch>>(
    () => api.get<Page<Batch>>("/v1/pick-batches", { warehouse: code, limit: 100 }),
    [code],
  );
  const detail = useApi<Batch>(
    selectedRef ? () => api.get<Batch>(`/v1/pick-batches/${encodeURIComponent(selectedRef)}`) : null,
    [selectedRef],
  );

  /** Only orders the warehouse would batch: batch or auto pick mode. */
  const orders = useMemo(
    () => (waiting.data?.items ?? []).filter((d) => d.pick_mode === "batch" || d.pick_mode === "auto"),
    [waiting.data],
  );

  const groups = suggest.data?.groups ?? [];
  const maxOrders = suggest.data?.max_orders;

  /** The zones a waiting order's lines sit in, as the suggestion sees them. */
  const zonesOf = (ref: string) => groups.filter((g) => g.deliveries.includes(ref)).map((g) => g.zone).join(", ");

  const toggle = (ref: string) =>
    setTicked((cur) => (cur.includes(ref) ? cur.filter((r) => r !== ref) : [...cur, ref]));

  const chosen = orders.filter((d) => ticked.includes(d.external_ref));
  const chosenLines = chosen.reduce((n, d) => n + d.lines.length, 0);
  const overMax = maxOrders !== undefined && chosen.length > maxOrders;

  const created = detail.data && detail.data.external_ref === createdRef ? detail.data : null;

  const create = async () => {
    const out = await action.run(() => api.message<Accepted>("/v1/pick-batches", {
      warehouse: code ?? "",
      deliveries: ticked,
      assigned_to: assignedTo.trim() || null,
    }));
    if (!out) return;
    const ref = out.wms_id;
    setTicked([]);
    setCreatedRef(ref);
    setSelectedRef(ref);
    await batches.reload();
    await waiting.reload();
    await suggest.reload();
  };

  const batchColumns: Column<Batch>[] = [
    { key: "ref", header: "Batch", width: "120px", render: (b) => <b>{b.external_ref}</b> },
    { key: "orders", header: "Orders", width: "90px", render: (b) => String(b.orders) },
    { key: "lines", header: "Lines", width: "90px", render: (b) => String(b.lines) },
    { key: "status", header: "Status", width: "120px", render: (b) => statusPill(b.status) },
    { key: "assigned", header: "Assigned to", render: (b) => b.assigned_to ?? <Muted>unassigned</Muted> },
    { key: "created", header: "Created", width: "110px", render: (b) => <Muted>{fmtWhen(b.created_at)}</Muted> },
  ];

  return (
    <>
      <Main>
        <div className="flex items-center gap-3">
          <Link
            to="/deliveries"
            aria-label="Back to deliveries"
            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-md border border-line no-underline"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ccd6f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
            </svg>
          </Link>
          <div className="flex flex-col gap-1 min-w-0">
            <Eyebrow>{warehouse?.name ?? "Warehouse"} · one walk, several orders</Eyebrow>
            <h1 className="m-0 text-[30px] leading-9 font-bold">
              <span className="text-brand">Batch pick</span> builder
            </h1>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 items-start">
          <Card className="p-5 flex flex-col gap-3">
            <Eyebrow tone="muted">Waiting orders · tick to add</Eyebrow>
            {waiting.error && <Notice tone="gold">{waiting.error}</Notice>}
            {orders.length === 0 && (
              <Muted className="text-sm">
                {waiting.loading
                  ? "Loading…"
                  : "Nothing waiting that wants batching. Orders come here once they are allocated and their pick mode is batch or auto."}
              </Muted>
            )}
            <div className="flex flex-col rounded-lg border border-line">
              {orders.map((d) => {
                const on = ticked.includes(d.external_ref);
                return (
                  <label
                    key={d.external_ref}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(d.external_ref)}
                      aria-label={`Add ${d.external_ref}`}
                    />
                    <b className="w-[120px] shrink-0 truncate">{d.external_ref}</b>
                    <span className="grow truncate">{d.ship_to.name}</span>
                    <Muted className="shrink-0">{plural(d.lines.length, "line")}</Muted>
                    <Muted className="w-[130px] shrink-0 truncate text-right">{zonesOf(d.external_ref) || "—"}</Muted>
                  </label>
                );
              })}
            </div>
          </Card>

          <Card className="p-5 flex flex-col gap-4">
            <Eyebrow tone="muted">This batch</Eyebrow>
            <div className="grid grid-cols-3 gap-4">
              <StatTile label="Orders" value={String(chosen.length)} />
              <StatTile label="Lines" value={String(chosenLines)} />
              <StatTile
                label="Stops"
                value={created ? String(created.stops.length + created.done_stops) : "—"}
                hint={created ? `${created.external_ref} walked` : "known once the batch is built"}
              />
            </div>
            <Muted className="text-sm leading-5">
              {chosen.length === 0
                ? "Tick the orders that should be walked together."
                : `${plural(chosen.length, "order")} · ${plural(chosenLines, "line")}`}
            </Muted>

            <Section title="Totes">
              {chosen.length === 0 ? (
                <Muted className="text-sm">One tote per order, numbered in the order you tick them.</Muted>
              ) : (
                <div className="flex flex-col rounded-lg border border-line">
                  {ticked.map((ref, i) => {
                    const order = chosen.find((d) => d.external_ref === ref);
                    return (
                      <div key={ref} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                        <span className="truncate">tote {i + 1} → {ref}</span>
                        <Muted className="shrink-0">{order?.ship_to.name ?? "—"}</Muted>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            <Section title="Suggestions">
              {groups.length === 0 ? (
                <Muted className="text-sm">
                  {suggest.loading ? "Loading…" : "Nothing worth grouping right now."}
                </Muted>
              ) : (
                <div className="flex flex-col gap-2">
                  {groups.map((g) => (
                    <div key={g.zone} className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
                      <span className="grow text-sm leading-5 truncate">
                        {plural(g.orders, "order")} in {g.zone} · {plural(g.lines, "line")} → {plural(g.stops, "stop")}, saves {g.saved}
                      </span>
                      <Button small onClick={() => setTicked(g.deliveries)}>Use this suggestion</Button>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Field label="Assign to" hint={maxOrders ? `Up to ${plural(maxOrders, "order")} in one batch` : undefined}>
              <Input
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                placeholder="op-017"
                aria-label="Assign to"
              />
            </Field>

            {overMax && maxOrders !== undefined && (
              <Notice tone="gold">{`Up to ${plural(maxOrders, "order")} in one batch here. Untick ${chosen.length - maxOrders}.`}</Notice>
            )}
            {action.error && <Notice tone="gold">{action.error}</Notice>}
            {created && (
              <Notice tone="ok">
                {`${created.external_ref} created · ${plural(created.orders, "order")} · ${plural(created.lines, "line")} → ${plural(created.stops.length + created.done_stops, "stop")}`}
              </Notice>
            )}

            {write && (
              <Button
                variant="primary"
                onClick={() => void create()}
                disabled={action.busy || ticked.length === 0 || overMax}
              >
                Create batch
              </Button>
            )}
          </Card>
        </div>

        <Section title="Open batches">
          {batches.error && <Notice tone="gold">{batches.error}</Notice>}
          <Table
            columns={batchColumns}
            rows={batches.data?.items ?? []}
            rowKey={(b) => b.external_ref}
            onRowClick={(b) => { setSelectedRef(b.external_ref); setCreatedRef(null); }}
            selectedKey={selectedRef}
            empty={batches.loading ? "Loading…" : "No batches yet. Tick a few orders above and build one."}
          />
        </Section>
        <Muted className="text-xs leading-4">
          Each order keeps its own pick task, its own reservations and its own ledger lines. The batch only decides the order of the walk and which tote each order's items go in.
        </Muted>
      </Main>

      <DetailPanel>
        {detail.data && <BatchDetail key={detail.data.external_ref} batch={detail.data} write={write} reload={async () => { await detail.reload(); await batches.reload(); }} />}
        {!detail.data && detail.loading && <Muted className="text-sm">Loading…</Muted>}
        {!detail.data && !detail.loading && detail.error && <Notice tone="gold">{detail.error}</Notice>}
        {!detail.data && !detail.loading && !detail.error && (
          <DetailHeader eyebrow="Pick batch" title="—" subtitle="Pick a batch to see its totes and the stops that are left on the walk." />
        )}
      </DetailPanel>
    </>
  );
}
