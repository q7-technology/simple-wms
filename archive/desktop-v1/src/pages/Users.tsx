import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { AuditRow, Device, Operator, Page, User, WarehouseSettings } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtWhen } from "../lib/format";
import { useAction, useApi } from "../lib/useApi";
import {
  Button, Chip, DetailHeader, DetailPanel, Field, Input, KeyValue, Muted, Notice, PageHeader, Pill,
  Section, Select, Table, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

/* --- shared bits --------------------------------------------------------- */

const USER_ROLES: { value: string; label: string }[] = [
  { value: "picker", label: "Picker" },
  { value: "receiver", label: "Receiver" },
  { value: "supervisor", label: "Supervisor" },
  { value: "inventory_controller", label: "Inventory controller" },
  { value: "admin", label: "Admin" },
];
const ROLE_LABEL: Record<string, string> = Object.fromEntries(USER_ROLES.map((r) => [r.value, r.label]));
const OPERATOR_ROLES = ["picker", "packer", "receiver", "counter", "supervisor"];

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function roleLabel(role: string) {
  return ROLE_LABEL[role] ?? cap(role.replace(/_/g, " "));
}
function warehousesLabel(codes: string[]) {
  return codes.includes("*") ? "All" : codes.length ? codes.join(", ") : "—";
}
function parseWarehouses(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}
/** Lists come back as a page; be kind if a plain array turns up. */
function items<T>(d: Page<T> | T[] | null): T[] {
  if (!d) return [];
  return Array.isArray(d) ? d : d.items ?? [];
}
function confirmed(msg: string) {
  return typeof window !== "undefined" && typeof window.confirm === "function" && window.confirm(msg) === true;
}
function auditAction(row: AuditRow) {
  const words = cap(row.action.replace(/[._]+/g, " "));
  const detail = Object.entries(row.detail ?? {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 3)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
  return [words + (row.target ? ` ${row.target}` : ""), ...detail].join(" · ");
}

type Person = { kind: "user"; key: string; user: User } | { kind: "operator"; key: string; operator: Operator };
type Panel =
  | { mode: "none" }
  | { mode: "person"; key: string }
  | { mode: "add-operator" }
  | { mode: "add-user" }
  | { mode: "register-device" };

function RoleChips({ roles, onChange }: { roles: string[]; onChange?: (roles: string[]) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {OPERATOR_ROLES.map((r) => (
        <Chip
          key={r}
          active={roles.includes(r)}
          onClick={onChange ? () => onChange(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]) : undefined}
        >
          {cap(r)}
        </Chip>
      ))}
    </div>
  );
}

/* --- page ---------------------------------------------------------------- */

export function Users() {
  const { user: me, warehouse, warehouses, can } = useAuth();
  const admin = can("access:admin");
  const [panel, setPanel] = useState<Panel>({ mode: "none" });

  const users = useApi<Page<User>>(() => api.get<Page<User>>("/v1/users"), []);
  const operators = useApi<Page<Operator>>(() => api.get<Page<Operator>>("/v1/operators"), []);
  const devices = useApi<Page<Device>>(() => api.get<Page<Device>>("/v1/devices"), []);
  const audit = useApi<Page<AuditRow>>(() => api.get<Page<AuditRow>>("/v1/audit-log", { limit: 20 }), []);

  const people = useMemo<Person[]>(() => [
    ...items(users.data).map((u): Person => ({ kind: "user", key: `user:${u.wms_id}`, user: u })),
    ...items(operators.data).map((o): Person => ({ kind: "operator", key: `operator:${o.wms_id}`, operator: o })),
  ], [users.data, operators.data]);
  const deviceRows = items(devices.data);
  const auditRows = items(audit.data);
  const selected = panel.mode === "person" ? people.find((p) => p.key === panel.key) ?? null : null;
  const loading = (users.loading && !users.data) || (operators.loading && !operators.data);
  const loadError = users.error ?? operators.error ?? devices.error ?? audit.error;

  const refresh = () => Promise.all([users.reload(), operators.reload(), devices.reload(), audit.reload()]);

  const peopleColumns: Column<Person>[] = [
    { key: "name", header: "Name", render: (p) => <b>{p.kind === "user" ? p.user.display_name : p.operator.name}</b> },
    {
      key: "login", header: "Login", width: "130px",
      render: (p) => p.kind === "user" ? "Password" : p.operator.badge ? "Badge + PIN" : "ID + PIN",
    },
    {
      key: "role", header: "Role",
      render: (p) => p.kind === "user"
        ? <>{roleLabel(p.user.role)}{p.user.two_factor ? <Muted> · 2FA on</Muted> : null}</>
        : p.operator.roles.map(cap).join(", ") || <Muted>No roles</Muted>,
    },
    { key: "warehouse", header: "Warehouse", width: "140px", render: (p) => warehousesLabel(p.kind === "user" ? p.user.warehouses : p.operator.warehouses) },
    {
      key: "status", header: "Status", width: "130px",
      render: (p) => {
        const active = p.kind === "user" ? p.user.active : p.operator.active;
        if (!active) return <Pill tone="muted">Deactivated</Pill>;
        if (p.kind === "operator" && p.operator.locked) return <Pill tone="warn">Locked out</Pill>;
        return <Pill tone="info">Active</Pill>;
      },
    },
  ];

  const deviceAction = useAction();
  const deviceColumns: Column<Device>[] = [
    { key: "code", header: "Device", width: "150px", render: (d) => <b>{d.code}</b> },
    { key: "name", header: "Model", render: (d) => d.name || <Muted>—</Muted> },
    { key: "warehouse", header: "Warehouse", width: "130px", render: (d) => d.warehouse ?? <Muted>—</Muted> },
    { key: "seen", header: "Seen", width: "110px", render: (d) => d.last_seen_at ? fmtWhen(d.last_seen_at) : <Muted>never</Muted> },
    {
      key: "status", header: "Status", width: "190px",
      render: (d) => (
        <span className="inline-flex items-center gap-2">
          {d.active ? <Pill tone="info">Active</Pill> : <Pill tone="muted">Deactivated</Pill>}
          {admin && d.active && (
            <Button
              small
              disabled={deviceAction.busy}
              onClick={async () => {
                if (!confirmed(`Deactivate scanner ${d.code}? A PIN will no longer work on it.`)) return;
                const ok = await deviceAction.run(() => api.post(`/v1/devices/${d.wms_id}/deactivate`));
                if (ok !== undefined) await refresh();
              }}
            >
              Deactivate
            </Button>
          )}
        </span>
      ),
    },
  ];

  const auditColumns: Column<AuditRow>[] = [
    { key: "when", header: "When", width: "90px", render: (r) => fmtWhen(r.at) },
    { key: "who", header: "Who", width: "150px", render: (r) => r.actor },
    { key: "device", header: "Device", width: "130px", render: (r) => r.device ?? (r.actor_type === "user" ? "Desktop" : <Muted>—</Muted>) },
    { key: "action", header: "Action", render: (r) => auditAction(r) },
    {
      key: "result", header: "Result", width: "110px",
      render: (r) => r.action.includes("locked") ? <Pill tone="warn">Locked out</Pill>
        : r.action.includes("failed") ? <Pill tone="warn">Refused</Pill>
          : <Pill tone="info">Allowed</Pill>,
    },
  ];

  return (
    <>
      <Main>
        <PageHeader
          eyebrow="Access"
          accent="Users,"
          title="roles and devices"
          actions={admin ? <>
            <Button onClick={() => setPanel({ mode: "add-user" })}>Add user</Button>
            <Button onClick={() => setPanel({ mode: "register-device" })}>Register scanner</Button>
            <Button variant="primary" onClick={() => setPanel({ mode: "add-operator" })}>Add operator</Button>
          </> : undefined}
        />

        {loadError && <Notice tone="gold">{loadError}</Notice>}
        {deviceAction.error && <Notice tone="gold">{deviceAction.error}</Notice>}
        {loading && <Muted className="text-sm">Loading…</Muted>}

        <Section title="People">
          <Table
            columns={peopleColumns}
            rows={people}
            rowKey={(p) => p.key}
            onRowClick={(p) => setPanel({ mode: "person", key: p.key })}
            selectedKey={selected?.key ?? null}
            empty="Nobody yet. Add a desktop user or a scanner operator to get started."
          />
        </Section>

        <Section title="Registered scanners">
          <Table
            columns={deviceColumns}
            rows={deviceRows}
            rowKey={(d) => d.wms_id}
            empty="No scanners registered. Register one so a PIN works on it."
          />
        </Section>

        <Section title="Audit log (cannot be edited)">
          <Table
            columns={auditColumns}
            rows={auditRows}
            rowKey={(r) => r.wms_id}
            empty="Nothing logged yet. Every sign in, change and refusal lands here."
          />
        </Section>
      </Main>

      {panel.mode === "add-operator" ? (
        <AddOperatorPanel
          defaultWarehouse={warehouse?.code ?? ""}
          onDone={async (created) => { await refresh(); setPanel(created ? { mode: "person", key: `operator:${created}` } : { mode: "none" }); }}
        />
      ) : panel.mode === "add-user" ? (
        <AddUserPanel
          defaultWarehouse={warehouse?.code ?? ""}
          onDone={async (created) => { await refresh(); setPanel(created ? { mode: "person", key: `user:${created}` } : { mode: "none" }); }}
        />
      ) : panel.mode === "register-device" ? (
        <RegisterDevicePanel
          warehouses={warehouses.map((w) => ({ code: w.code, name: w.name }))}
          defaultWarehouse={warehouse?.code ?? ""}
          onDone={async () => { await refresh(); setPanel({ mode: "none" }); }}
        />
      ) : selected?.kind === "operator" ? (
        <OperatorPanel
          key={selected.key}
          operator={selected.operator}
          devices={deviceRows}
          settings={warehouse?.settings}
          admin={admin}
          onChanged={refresh}
        />
      ) : selected?.kind === "user" ? (
        <UserPanel key={selected.key} user={selected.user} isMe={me?.wms_id === selected.user.wms_id} admin={admin} onChanged={refresh} />
      ) : (
        <DetailPanel>
          <DetailHeader eyebrow="Detail" title="—" subtitle="Select a person to see roles, devices and what they can override." />
        </DetailPanel>
      )}
    </>
  );
}

/* --- operator panel ------------------------------------------------------ */

function OperatorPanel({ operator, devices, settings, admin, onChanged }: {
  operator: Operator; devices: Device[]; settings?: Partial<WarehouseSettings>; admin: boolean; onChanged: () => Promise<unknown>;
}) {
  const [roles, setRoles] = useState<string[]>(operator.roles);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const action = useAction();
  useEffect(() => setRoles(operator.roles), [operator.roles]);

  const rolesChanged = roles.length !== operator.roles.length || roles.some((r) => !operator.roles.includes(r));
  const supervisor = roles.includes("supervisor");
  const known = devices
    .filter((d) => d.active && (operator.warehouses.includes("*") || (d.warehouse !== null && operator.warehouses.includes(d.warehouse))))
    .map((d) => d.code);

  const post = async (path: string, body?: unknown) => {
    const ok = await action.run(() => api.post(`/v1/operators/${operator.wms_id}${path}`, body));
    if (ok !== undefined) await onChanged();
    return ok !== undefined;
  };
  const saveRoles = async () => {
    const ok = await action.run(() => api.patch(`/v1/operators/${operator.wms_id}`, { roles }));
    if (ok !== undefined) await onChanged();
  };
  const savePin = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) { action.clear(); return; }
    if (await post("/reset-pin", { pin })) { setPinOpen(false); setPin(""); }
  };

  return (
    <DetailPanel
      footer={admin ? <>
        {operator.active && <Button onClick={() => { setPinOpen((v) => !v); setPin(""); action.clear(); }}>Reset PIN</Button>}
        {operator.active ? (
          <Button variant="gold" disabled={action.busy} onClick={() => { if (confirmed(`Deactivate ${operator.name}? Their PIN stops working straight away.`)) void post("/deactivate"); }}>
            Deactivate
          </Button>
        ) : (
          <Button variant="gold" disabled={action.busy} onClick={() => void post("/reactivate")}>Reactivate</Button>
        )}
      </> : undefined}
    >
      <DetailHeader
        eyebrow="Operator"
        title={operator.name}
        subtitle={`${operator.code} · badge ${operator.badge ?? "none"} · ${warehousesLabel(operator.warehouses)}`}
      />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {!operator.active && <Notice>Deactivated. Nothing is deleted; reactivate to let them sign in again.</Notice>}
      {operator.locked && (
        <div className="flex items-center justify-between gap-3">
          <Pill tone="warn">Locked out</Pill>
          {admin && <Button small disabled={action.busy} onClick={() => void post("/unlock")}>Unlock</Button>}
        </div>
      )}
      <Section
        title="Roles"
        action={admin && rolesChanged ? <Button small variant="primary" disabled={action.busy} onClick={() => void saveRoles()}>Save</Button> : undefined}
      >
        <RoleChips roles={roles} onChange={admin ? setRoles : undefined} />
      </Section>
      <KeyValue items={[
        { label: "Login", value: "Badge or ID + PIN" },
        { label: "Known devices", value: known.length ? known.join(", ") : "none yet" },
        { label: "Idle logout", value: settings?.idle_logout_minutes !== undefined ? `${settings.idle_logout_minutes} min` : "—" },
        { label: "Lockout", value: settings?.pin_lockout_tries !== undefined ? `${settings.pin_lockout_tries} wrong PINs` : "—" },
      ]} />
      <Section title="Can override with supervisor badge">
        <div className="flex flex-col rounded-lg border border-line">
          {[
            ["Short ship", supervisor ? "Yes" : "No"],
            ["Stock adjustment", supervisor ? "Yes" : "No"],
            ["Putaway to other shelf", "No badge needed"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between items-center gap-3 px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
              <span>{k}</span>
              {v === "No badge needed" ? <Muted>{v}</Muted> : <span className="text-ink">{v}</span>}
            </div>
          ))}
        </div>
      </Section>
      {pinOpen && (
        <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={savePin}>
          <Field label="New PIN" hint="4 to 8 digits. Hashed; never shown again." error={action.fieldErrors.pin}>
            <Input aria-label="New PIN" inputMode="numeric" pattern="\d{4,8}" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" small disabled={action.busy || !/^\d{4,8}$/.test(pin)}>Save PIN</Button>
            <Button small onClick={() => { setPinOpen(false); setPin(""); }}>Cancel</Button>
          </div>
        </form>
      )}
    </DetailPanel>
  );
}

/* --- user panel ---------------------------------------------------------- */

function UserPanel({ user, isMe, admin, onChanged }: { user: User; isMe: boolean; admin: boolean; onChanged: () => Promise<unknown> }) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [role, setRole] = useState(user.role);
  const [warehousesText, setWarehousesText] = useState(user.warehouses.join(", "));
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState("");
  // turning on a second factor: a secret to scan, then a code to prove it
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const action = useAction();
  useEffect(() => {
    setDisplayName(user.display_name);
    setRole(user.role);
    setWarehousesText(user.warehouses.join(", "));
  }, [user.display_name, user.role, user.warehouses]);

  const parsed = parseWarehouses(warehousesText);
  const changes: Record<string, unknown> = {};
  if (displayName.trim() !== user.display_name) changes.display_name = displayName.trim();
  if (role !== user.role) changes.role = role;
  if (parsed.join(",") !== user.warehouses.join(",")) changes.warehouses = parsed;
  const dirty = Object.keys(changes).length > 0;

  const post = async (path: string, body?: unknown) => {
    const ok = await action.run(() => api.post(`/v1/users/${user.wms_id}${path}`, body));
    if (ok !== undefined) await onChanged();
    return ok !== undefined;
  };
  const save = async () => {
    const ok = await action.run(() => api.patch(`/v1/users/${user.wms_id}`, changes));
    if (ok !== undefined) await onChanged();
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) return;
    if (await post("/password", { password })) { setPwOpen(false); setPassword(""); }
  };
  const startSetup = async () => {
    const got = await action.run(() =>
      api.post<{ secret: string; otpauth_url: string }>("/v1/auth/2fa/setup"));
    if (got) { setSetup(got); setCode(""); }
  };
  const finishSetup = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api.post("/v1/auth/2fa/enable", { code: code.trim() }));
    if (ok !== undefined) { setSetup(null); setCode(""); await onChanged(); }
  };

  return (
    <DetailPanel
      footer={admin ? <>
        {user.active && <Button onClick={() => { setPwOpen((v) => !v); setPassword(""); action.clear(); }}>Set password</Button>}
        {isMe ? null : user.active ? (
          <Button variant="gold" disabled={action.busy} onClick={() => { if (confirmed(`Deactivate ${user.display_name}? They are signed out everywhere.`)) void post("/deactivate"); }}>
            Deactivate
          </Button>
        ) : (
          <Button variant="gold" disabled={action.busy} onClick={() => void post("/reactivate")}>Reactivate</Button>
        )}
      </> : undefined}
    >
      <DetailHeader eyebrow="User" title={user.display_name} subtitle={`${user.username} · ${roleLabel(user.role)}`} />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      {!user.active && <Notice>Deactivated. Nothing is deleted; reactivate to let them sign in again.</Notice>}
      <div className="flex flex-col gap-3">
        <Field label="Display name" error={action.fieldErrors.display_name}>
          <Input aria-label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!admin} />
        </Field>
        <Field label="Role" error={action.fieldErrors.role}>
          <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} disabled={!admin}>
            {USER_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            {!USER_ROLES.some((r) => r.value === user.role) && <option value={user.role}>{roleLabel(user.role)}</option>}
          </Select>
        </Field>
        <Field label="Warehouses" hint="Comma separated codes, or * for all" error={action.fieldErrors.warehouses}>
          <Input aria-label="Warehouses" value={warehousesText} onChange={(e) => setWarehousesText(e.target.value)} disabled={!admin} />
        </Field>
        {admin && dirty && (
          <div><Button small variant="primary" disabled={action.busy} onClick={() => void save()}>Save</Button></div>
        )}
      </div>
      <KeyValue items={[
        { label: "Login", value: "Password" + (user.two_factor ? " · 2FA on" : "") },
        { label: "Email", value: user.email ?? "—" },
        { label: "Last sign in", value: user.last_login_at ? fmtWhen(user.last_login_at) : "never" },
        { label: "Created", value: fmtWhen(user.created_at) },
      ]} />
      <Section title="Second factor">
        {user.locked && (
          <Notice tone="gold">
            Locked after too many wrong passwords.
            {admin && <> <button type="button" className="underline bg-transparent border-0 text-gold cursor-pointer p-0"
              onClick={() => void post("/unlock")}>Unlock them</button></>}
          </Notice>
        )}
        {user.two_factor ? (
          <div className="flex items-center justify-between gap-3">
            <Muted className="text-sm">An authenticator app is asked for after the password.</Muted>
            {admin && (
              <Button small variant="gold" disabled={action.busy}
                onClick={() => { if (confirmed(`Clear the second factor for ${user.display_name}? They set it up again next time they sign in.`)) void post("/clear-2fa"); }}>
                Lost phone
              </Button>
            )}
          </div>
        ) : isMe ? (
          setup ? (
            <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={finishSetup}>
              <Muted className="text-xs leading-4">
                Add this to your authenticator app, then type the code it shows.
              </Muted>
              <div className="mono text-xs break-all text-ink">{setup.secret}</div>
              <a className="text-xs break-all" href={setup.otpauth_url}>Open in an app</a>
              <Field label="Code" error={action.fieldErrors.code}>
                <Input aria-label="Code" inputMode="numeric" maxLength={8} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" small disabled={action.busy || code.length < 6}>
                  Turn it on
                </Button>
                <Button small onClick={() => { setSetup(null); setCode(""); action.clear(); }}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <Muted className="text-sm">Not set up. Recommended for an admin.</Muted>
              <Button small disabled={action.busy} onClick={() => void startSetup()}>Set up</Button>
            </div>
          )
        ) : (
          <Muted className="text-sm">Not set up. Only they can turn it on, from their own account.</Muted>
        )}
      </Section>
      {isMe && admin && <Muted className="text-xs leading-4">This is you. You cannot deactivate your own account.</Muted>}
      {pwOpen && (
        <form className="flex flex-col gap-3 rounded-lg border border-line p-3" onSubmit={savePassword}>
          <Field label="New password" hint="At least 12 characters." error={action.fieldErrors.password}>
            <Input aria-label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" small disabled={action.busy || password.length < 12}>Save password</Button>
            <Button small onClick={() => { setPwOpen(false); setPassword(""); }}>Cancel</Button>
          </div>
        </form>
      )}
    </DetailPanel>
  );
}

/* --- add operator -------------------------------------------------------- */

function AddOperatorPanel({ defaultWarehouse, onDone }: { defaultWarehouse: string; onDone: (createdId: string | null) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [badge, setBadge] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [warehousesText, setWarehousesText] = useState(defaultWarehouse);
  const action = useAction();
  const pinOk = /^\d{4,8}$/.test(pin);
  const ready = code.trim() && name.trim() && pinOk && roles.length > 0 && parseWarehouses(warehousesText).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const created = await action.run(() => api.post<{ wms_id: string }>("/v1/operators", {
      code: code.trim(), name: name.trim(), pin, badge: badge.trim() || null, roles, warehouses: parseWarehouses(warehousesText),
    }));
    if (created !== undefined) await onDone(created?.wms_id ?? null);
  };

  return (
    <DetailPanel footer={<>
      <Button onClick={() => void onDone(null)}>Cancel</Button>
      <Button type="submit" form="add-operator" variant="primary" disabled={action.busy || !ready}>Create operator</Button>
    </>}>
      <DetailHeader eyebrow="Add operator" title="New scanner operator" subtitle="Signs in on a scanner with a badge or ID and a PIN." />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <form id="add-operator" className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Code" hint="e.g. op-017" error={action.fieldErrors.code}>
          <Input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </Field>
        <Field label="Name" error={action.fieldErrors.name}>
          <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="PIN" hint="4 to 8 digits. Hashed; never shown again." error={action.fieldErrors.pin}>
          <Input aria-label="PIN" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
        </Field>
        <Field label="Badge (optional)" hint="The barcode on their badge, if they have one." error={action.fieldErrors.badge}>
          <Input aria-label="Badge" value={badge} onChange={(e) => setBadge(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs leading-4 text-muted">Roles</span>
          <RoleChips roles={roles} onChange={setRoles} />
          {action.fieldErrors.roles && <span className="text-xs leading-4 text-gold">{action.fieldErrors.roles}</span>}
        </div>
        <Field label="Warehouses" hint="Comma separated codes, or * for all" error={action.fieldErrors.warehouses}>
          <Input aria-label="Warehouses" value={warehousesText} onChange={(e) => setWarehousesText(e.target.value)} />
        </Field>
      </form>
    </DetailPanel>
  );
}

/* --- add user ------------------------------------------------------------ */

function AddUserPanel({ defaultWarehouse, onDone }: { defaultWarehouse: string; onDone: (createdId: string | null) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("picker");
  const [warehousesText, setWarehousesText] = useState(defaultWarehouse);
  const [password, setPassword] = useState("");
  const action = useAction();
  const ready = username.trim() && displayName.trim() && password.length >= 12 && parseWarehouses(warehousesText).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const created = await action.run(() => api.post<{ wms_id: string }>("/v1/users", {
      username: username.trim(), display_name: displayName.trim(), email: email.trim() || null, role,
      warehouses: parseWarehouses(warehousesText), password,
    }));
    if (created !== undefined) await onDone(created?.wms_id ?? null);
  };

  return (
    <DetailPanel footer={<>
      <Button onClick={() => void onDone(null)}>Cancel</Button>
      <Button type="submit" form="add-user" variant="primary" disabled={action.busy || !ready}>Create user</Button>
    </>}>
      <DetailHeader eyebrow="Add user" title="New desktop user" subtitle="Signs in here with a username and password." />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <form id="add-user" className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Username" error={action.fieldErrors.username}>
          <Input aria-label="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label="Display name" error={action.fieldErrors.display_name}>
          <Input aria-label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Email" error={action.fieldErrors.email}>
          <Input aria-label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" error={action.fieldErrors.role}>
          <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
            {USER_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Warehouses" hint="Comma separated codes, or * for all" error={action.fieldErrors.warehouses}>
          <Input aria-label="Warehouses" value={warehousesText} onChange={(e) => setWarehousesText(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 12 characters." error={action.fieldErrors.password}>
          <Input aria-label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </form>
    </DetailPanel>
  );
}

/* --- register scanner ---------------------------------------------------- */

function RegisterDevicePanel({ warehouses, defaultWarehouse, onDone }: {
  warehouses: { code: string; name: string }[]; defaultWarehouse: string; onDone: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [warehouseCode, setWarehouseCode] = useState(defaultWarehouse);
  const action = useAction();
  const ready = code.trim() && name.trim() && warehouseCode;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const ok = await action.run(() => api.post("/v1/devices", { code: code.trim(), name: name.trim(), warehouse: warehouseCode }));
    if (ok !== undefined) await onDone();
  };

  return (
    <DetailPanel footer={<>
      <Button onClick={() => void onDone()}>Cancel</Button>
      <Button type="submit" form="register-device" variant="primary" disabled={action.busy || !ready}>Register</Button>
    </>}>
      <DetailHeader eyebrow="Register scanner" title="New scanner" subtitle="Registering the same code again updates it." />
      {action.error && <Notice tone="gold">{action.error}</Notice>}
      <form id="register-device" className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="Code" hint="e.g. SCN-BAL-07" error={action.fieldErrors.code}>
          <Input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </Field>
        <Field label="Model" hint="e.g. Zebra TC52" error={action.fieldErrors.name}>
          <Input aria-label="Model" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Warehouse" error={action.fieldErrors.warehouse}>
          <Select aria-label="Warehouse" value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)}>
            {warehouses.length === 0 && <option value="">No warehouses yet</option>}
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
      </form>
    </DetailPanel>
  );
}
