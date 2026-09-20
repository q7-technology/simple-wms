import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Owner, Page } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtWhen } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/** DEFAULT exists from the first migration and cannot be switched off. */
const HOUSE = "DEFAULT";

/** Lists come back as a page; be kind if a plain array turns up. */
function items<T>(d: Page<T> | T[] | null): T[] {
  if (!d) return [];
  return Array.isArray(d) ? d : d.items ?? [];
}

function confirmed(msg: string) {
  return typeof window !== "undefined" && typeof window.confirm === "function" && window.confirm(msg) === true;
}

/** The form's view of an owner. Strings throughout so the inputs stay controlled. */
interface Draft {
  code: string; name: string; contact: string; email: string; phone: string; note: string;
}
function emptyDraft(): Draft {
  return { code: "", name: "", contact: "", email: "", phone: "", note: "" };
}
function draftOf(o: Owner): Draft {
  return {
    code: o.code, name: o.name, contact: o.contact ?? "", email: o.email ?? "",
    phone: o.phone ?? "", note: o.note ?? "",
  };
}
function orNull(s: string): string | null {
  return s.trim() === "" ? null : s.trim();
}

export function Owners() {
  const { warehouse, can } = useAuth();
  const admin = can("access:admin");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [said, setSaid] = useState<string | null>(null);

  const owners = useApi<Page<Owner>>(() => api.get<Page<Owner>>("/v1/owners"), []);
  const save = useAction();

  const rows = useMemo(() => items(owners.data), [owners.data]);
  const owner = useMemo(() => rows.find((o) => o.code === selected) ?? null, [rows, selected]);

  // Keep the form in step with the row that is open.
  useEffect(() => { if (owner && !adding) setDraft(draftOf(owner)); }, [owner?.code, adding]); // eslint-disable-line react-hooks/exhaustive-deps

  const multiOwner = warehouse?.settings.multi_owner === true;

  function select(o: Owner) {
    setSelected(o.code);
    setAdding(false);
    setDraft(draftOf(o));
    setSaid(null);
    save.clear();
  }
  function startAdd() {
    setSelected(null);
    setAdding(true);
    setDraft(emptyDraft());
    setSaid(null);
    save.clear();
  }
  function patch(p: Partial<Draft>) { setDraft((d) => ({ ...d, ...p })); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      code: draft.code.trim().toUpperCase(),
      name: draft.name.trim(),
      contact: orNull(draft.contact),
      email: orNull(draft.email),
      phone: orNull(draft.phone),
      note: orNull(draft.note),
      active: owner && !adding ? owner.active : true,
      ...(owner && !adding ? { settings: owner.settings } : {}),
    };
    const reply = await save.run(() => api.post<Owner>("/v1/owners", body));
    if (!reply) return;
    setSaid(adding ? `Added ${body.code}.` : `Saved ${body.code}.`);
    setAdding(false);
    setSelected(body.code);
    await owners.reload();
  }

  async function setActive(o: Owner, active: boolean) {
    if (active === false && !confirmed(`Deactivate ${o.code}? Their stock and their history stay exactly where they are.`)) return;
    const reply = await save.run(() => api.post(`/v1/owners/${encodeURIComponent(o.code)}/${active ? "reactivate" : "deactivate"}`));
    if (reply === undefined) return;
    setSaid(active ? `${o.code} is back on.` : `${o.code} is deactivated.`);
    await owners.reload();
  }

  /* A refusal that names no field on screen — the DEFAULT 422, say — still gets said out loud. */
  const PANEL_FIELDS = ["name", "contact", "email", "phone", "note"];
  const looseError = save.error && !PANEL_FIELDS.some((k) => save.fieldErrors[k]) ? save.error : null;

  const columns: Column<Owner>[] = [
    { key: "code", header: "Owner", width: "140px", render: (o) => <b>{o.code}</b> },
    { key: "name", header: "Name", render: (o) => o.name },
    { key: "contact", header: "Contact", width: "170px", render: (o) => o.contact ?? <Muted>—</Muted> },
    { key: "email", header: "Email", width: "220px", render: (o) => o.email ?? <Muted>—</Muted> },
    {
      key: "status", header: "Status", width: "120px",
      render: (o) => o.active ? <Pill tone="info">Active</Pill> : <Pill tone="muted">Deactivated</Pill>,
    },
    { key: "created", header: "Created", width: "100px", render: (o) => fmtWhen(o.created_at) },
  ];

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="Whose stock it is"
          accent="Owners"
          title=""
          actions={admin ? <Button variant="primary" onClick={startAdd}>Add owner</Button> : undefined}
        />

        {warehouse && (multiOwner
          ? <Notice tone="ok">Multiple owners are on for {warehouse.code}.</Notice>
          : <Notice>One owner is switched on for {warehouse.code}. Turn on multiple owners in Settings to show the owner column across the screens.</Notice>
        )}

        {owners.error && <Notice tone="gold">{owners.error}</Notice>}
        {owners.loading && !owners.data && <Muted className="text-sm">Loading…</Muted>}
        {(owners.data || !owners.loading) && (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(o) => o.wms_id}
            onRowClick={select}
            selectedKey={owner?.wms_id ?? null}
            empty="No owners yet. DEFAULT is the house account everything falls back to."
          />
        )}
      </Main>

      {adding ? (
        <DetailPanel footer={<>
          <Button onClick={() => { setAdding(false); save.clear(); }}>Cancel</Button>
          <Button type="submit" form="owner-form" variant="primary" disabled={save.busy || !draft.code.trim() || !draft.name.trim()}>
            {save.busy ? "Saving…" : "Add owner"}
          </Button>
        </>}>
          <DetailHeader eyebrow="Add owner" title="New owner" subtitle="Whose stock it is. Nothing else changes." />
          {save.error && Object.keys(save.fieldErrors).length === 0 && <Notice tone="gold">{save.error}</Notice>}
          <form id="owner-form" className="flex flex-col gap-3" onSubmit={submit}>
            <Field label="Code" hint="Upper case, digits, dash and underscore. Typed in lower case, it is lifted for you." error={save.fieldErrors.code}>
              <Input
                aria-label="Code"
                value={draft.code}
                onChange={(e) => patch({ code: e.target.value.toUpperCase() })}
                placeholder="NORTHCO"
                autoFocus
              />
            </Field>
            <Field label="Name" error={save.fieldErrors.name}>
              <Input aria-label="Name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Northco Distribution" />
            </Field>
            <Field label="Contact" error={save.fieldErrors.contact}>
              <Input aria-label="Contact" value={draft.contact} onChange={(e) => patch({ contact: e.target.value })} />
            </Field>
            <Field label="Email" error={save.fieldErrors.email}>
              <Input aria-label="Email" type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} />
            </Field>
            <Field label="Phone" error={save.fieldErrors.phone}>
              <Input aria-label="Phone" value={draft.phone} onChange={(e) => patch({ phone: e.target.value })} />
            </Field>
            <Field label="Note" error={save.fieldErrors.note}>
              <Input aria-label="Note" value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
            </Field>
          </form>
        </DetailPanel>
      ) : owner ? (
        <DetailPanel footer={admin ? <>
          <Button type="submit" form="owner-form" variant="primary" disabled={save.busy || !draft.name.trim()}>
            {save.busy ? "Saving…" : "Save"}
          </Button>
          {owner.code !== HOUSE && (owner.active
            ? <Button variant="gold" disabled={save.busy} onClick={() => void setActive(owner, false)}>Deactivate</Button>
            : <Button variant="gold" disabled={save.busy} onClick={() => void setActive(owner, true)}>Reactivate</Button>)}
        </> : undefined}>
          <DetailHeader eyebrow="Owner" title={owner.code} subtitle={owner.name} />
          {looseError && <Notice tone="gold">{looseError}</Notice>}
          {said && <Notice>{said}</Notice>}
          {!owner.active && <Notice>Deactivated. Nothing is deleted; their stock and their history stay exactly where they are.</Notice>}

          <form id="owner-form" className="flex flex-col gap-3" onSubmit={submit}>
            <Field label="Name" error={save.fieldErrors.name}>
              <Input aria-label="Name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} disabled={!admin} />
            </Field>
            <Field label="Contact" error={save.fieldErrors.contact}>
              <Input aria-label="Contact" value={draft.contact} onChange={(e) => patch({ contact: e.target.value })} disabled={!admin} />
            </Field>
            <Field label="Email" error={save.fieldErrors.email}>
              <Input aria-label="Email" type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} disabled={!admin} />
            </Field>
            <Field label="Phone" error={save.fieldErrors.phone}>
              <Input aria-label="Phone" value={draft.phone} onChange={(e) => patch({ phone: e.target.value })} disabled={!admin} />
            </Field>
            <Field label="Note" error={save.fieldErrors.note}>
              <Input aria-label="Note" value={draft.note} onChange={(e) => patch({ note: e.target.value })} disabled={!admin} />
            </Field>
          </form>

          <KeyValue items={[
            { label: "Created", value: fmtWhen(owner.created_at) },
            { label: "Status", value: owner.active ? "Active" : "Deactivated" },
          ]} />

          <Muted className="text-xs leading-4">
            Everything in the system carries an owner. DEFAULT is the one everything falls back to and cannot be switched off.
          </Muted>
          {owner.code === HOUSE && (
            <Muted className="text-xs leading-4">The house account stays on. Add another owner instead.</Muted>
          )}
        </DetailPanel>
      ) : (
        <DetailPanel>
          <DetailHeader
            eyebrow="Owner"
            title="—"
            subtitle={admin ? "Pick a row to edit it, or add an owner." : "Pick a row to see who they are."}
          />
        </DetailPanel>
      )}
    </>
  );
}
