import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { SystemSecrets, SystemSettingKey, SystemSettings as SystemSettingsData, SystemSettingValues } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useAction, useApi } from "../lib/useApi";
import { Button, Card, Eyebrow, Field, Input, Muted, Notice, Select, Toggle } from "../ui";
import { USER_ROLES } from "./Users";

type NumKey = { [K in keyof SystemSettingValues]: SystemSettingValues[K] extends number ? K : never }[keyof SystemSettingValues];
type TextKey = { [K in keyof SystemSettingValues]: SystemSettingValues[K] extends string ? K : never }[keyof SystemSettingValues];
type SecretKey = keyof SystemSecrets;
/** A queued change. `null` clears the saved value so the server's .env applies again. */
type Draft = Partial<{ [K in keyof SystemSettingValues]: SystemSettingValues[K] | null } & Record<SecretKey, string | null>>;

const SAVED_FOR_MS = 3000;
const PATH = "/v1/system/settings";
const SECRET_KEYS: SecretKey[] = ["platen_key", "oidc_client_secret"];

/** Site-wide settings that used to live only in the server's .env file.
 * Saved to the WMS and picked up within a few seconds, no restart. */
export function SystemSettings() {
  const { can } = useAuth();
  const readable = can("system:read");
  const editable = can("system:write");

  const loaded = useApi<SystemSettingsData>(readable ? () => api.get<SystemSettingsData>(PATH) : null, [readable]);
  const [draft, setDraft] = useState<Draft>({});
  const [texts, setTexts] = useState<Partial<Record<NumKey, string>>>({});
  const [saved, setSaved] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), SAVED_FOR_MS);
    return () => clearTimeout(t);
  }, [saved]);

  if (!readable) return null;

  const data = loaded.data;
  const values: Partial<SystemSettingValues> = data?.values ?? {};
  const changes = Object.fromEntries(
    (Object.keys(draft) as SystemSettingKey[])
      .filter((k) => {
        const v = draft[k];
        if (v === null || SECRET_KEYS.includes(k as SecretKey)) return true;
        return v !== values[k as keyof SystemSettingValues];
      })
      .map((k) => [k, typeof draft[k] === "string" ? (draft[k] as string).trim() : draft[k]]),
  ) as Draft;
  const dirty = Object.keys(changes).length > 0;

  const put = (key: SystemSettingKey, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));
  const drop = (key: SystemSettingKey) => setDraft((d) => { const next = { ...d }; delete next[key]; return next; });
  const backToEnv = (key: SystemSettingKey) => {
    if (key in texts) setTexts((t) => { const next = { ...t }; delete next[key as NumKey]; return next; });
    put(key, null);
  };
  const undo = (key: SystemSettingKey) => drop(key);

  const setNumber = (key: NumKey, text: string) => {
    setTexts((t) => ({ ...t, [key]: text }));
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) drop(key);
    else put(key, n);
  };

  const save = async () => {
    if (!dirty) return;
    const result = await action.run(() => api.patch<SystemSettingsData>(PATH, changes));
    if (result === undefined) return;
    loaded.setData(result);
    setDraft({});
    setTexts({});
    setSaved(true);
  };

  /** Where the value comes from, and a way back to the .env file. */
  const source = (key: SystemSettingKey): ReactNode => {
    if (!data) return null;
    if (draft[key] === null) {
      return (
        <SourceLine text="Uses .env after Save">
          {editable && <LinkButton label={`Undo for ${labels[key]}`} onClick={() => undo(key)}>Undo</LinkButton>}
        </SourceLine>
      );
    }
    const from = data.source[key];
    if (from === "settings") {
      return (
        <SourceLine text="Saved here">
          {editable && <LinkButton label={`Use .env for ${labels[key]}`} onClick={() => backToEnv(key)}>Use .env</LinkButton>}
        </SourceLine>
      );
    }
    return <SourceLine text={from === "env" ? "From .env" : "Built-in default"} />;
  };

  const num = (key: NumKey, hint?: ReactNode) => (
    <div className="flex flex-col gap-1 grow min-w-0">
      <Field label={labels[key]} hint={hint} error={action.fieldErrors[key]}>
        <Input
          aria-label={labels[key]}
          type="number"
          value={texts[key] ?? (draft[key] === null || values[key] === undefined ? "" : String(draft[key] ?? values[key]))}
          onChange={(e) => setNumber(key, e.target.value)}
          disabled={!editable}
        />
      </Field>
      {source(key)}
    </div>
  );

  const text = (key: TextKey, opts: { placeholder?: string; type?: string; hint?: ReactNode } = {}) => {
    const v = draft[key];
    return (
      <div className="flex flex-col gap-1 pb-2">
        <Field label={labels[key]} hint={opts.hint} error={action.fieldErrors[key]}>
          <Input
            aria-label={labels[key]}
            type={opts.type ?? "text"}
            placeholder={opts.placeholder}
            value={v === null ? "" : (v ?? values[key] ?? "")}
            onChange={(e) => put(key, e.target.value)}
            disabled={!editable}
          />
        </Field>
        {source(key)}
      </div>
    );
  };

  const secret = (key: SecretKey, hint?: ReactNode) => {
    const v = draft[key];
    return (
      <div className="flex flex-col gap-1 pb-2">
        <Field label={labels[key]} hint={hint} error={action.fieldErrors[key]}>
          <Input
            aria-label={labels[key]}
            type="password"
            autoComplete="off"
            placeholder={data?.secrets[key] ? "Saved · type to replace" : "Not set"}
            value={typeof v === "string" ? v : ""}
            onChange={(e) => (e.target.value === "" ? drop(key) : put(key, e.target.value))}
            disabled={!editable}
          />
        </Field>
        {source(key)}
      </div>
    );
  };

  const fieldErrors = Object.entries(action.fieldErrors);
  const createUsers = draft.oidc_create_users ?? values.oidc_create_users ?? false;
  const role = draft.oidc_default_role ?? values.oidc_default_role ?? "picker";

  return (
    <section aria-labelledby="system-settings-h" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="system-settings-h" className="m-0 text-[17px] font-extrabold">Across all warehouses</h2>
          <Muted className="text-[13px]">
            Saved to the WMS and used everywhere within a few seconds, no restart. Anything not set here comes from the server's .env file.
          </Muted>
        </div>
        {data && (
          <div className="flex items-center gap-3">
            {saved && <Muted className="text-sm">Saved</Muted>}
            {editable && <Button variant="primary" disabled={!dirty || action.busy} onClick={() => void save()}>Save changes</Button>}
          </div>
        )}
      </div>

      {loaded.error && <Notice tone="gold">{loaded.error}</Notice>}
      {action.error && (
        <Notice tone="gold">
          {fieldErrors.length > 0 ? fieldErrors.map(([k, m]) => `${k.replace(/_/g, " ")}: ${m}`).join("; ") : action.error}
        </Notice>
      )}
      {!editable && <Notice>Read only. Changing these needs the system write scope.</Notice>}
      {loaded.loading && !data && <Muted className="text-sm">Loading…</Muted>}

      {data && (
        <div className="grid grid-cols-2 gap-6">
          <Group title="Integrations">
            {num("message_ttl_hours", "A repeated message_id inside this window returns the first reply")}
            <div className="flex gap-2 pt-2">
              {num("worker_poll_seconds")}
              {num("worker_http_timeout_seconds")}
            </div>
          </Group>

          <Group title="Printing · Platen">
            {secret("platen_key", "Sent with every print job. The Platen URL is per warehouse, above.")}
          </Group>

          <Group title="Single sign-on">
            {text("oidc_issuer", { type: "url", placeholder: "https://login.example.com", hint: "Leave blank to turn single sign-on off" })}
            {text("oidc_client_id")}
            {secret("oidc_client_secret")}
            {text("oidc_redirect_uri", { type: "url" })}
            {text("oidc_scopes", { placeholder: "openid email profile" })}
            {text("oidc_name", { placeholder: "Single sign-on" })}
            <Toggle
              label={labels.oidc_create_users}
              hint="The first sign-in makes a WMS account"
              checked={draft.oidc_create_users === null ? false : createUsers}
              onChange={editable ? (v) => put("oidc_create_users", v) : undefined}
              disabled={!editable}
            />
            {source("oidc_create_users")}
            <div className="flex flex-col gap-1 pt-2">
              <Field label={labels.oidc_default_role} error={action.fieldErrors.oidc_default_role}>
                <Select
                  aria-label={labels.oidc_default_role}
                  value={draft.oidc_default_role === null ? (values.oidc_default_role ?? "picker") : role}
                  onChange={(e) => put("oidc_default_role", e.target.value)}
                  disabled={!editable}
                >
                  {USER_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </Select>
              </Field>
              {source("oidc_default_role")}
            </div>
          </Group>
        </div>
      )}
    </section>
  );
}

const labels: Record<SystemSettingKey, string> = {
  message_ttl_hours: "Duplicate window (h)",
  worker_poll_seconds: "Worker poll (s)",
  worker_http_timeout_seconds: "HTTP timeout (s)",
  platen_key: "Platen key",
  oidc_issuer: "Issuer",
  oidc_client_id: "Client ID",
  oidc_client_secret: "Client secret",
  oidc_redirect_uri: "Redirect URI",
  oidc_scopes: "Scopes",
  oidc_name: "Name on the sign-in button",
  oidc_create_users: "Make accounts for new people",
  oidc_default_role: "Role for new accounts",
};

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-6 flex flex-col gap-2">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </Card>
  );
}

function SourceLine({ text, children }: { text: string; children?: ReactNode }) {
  return <span className="flex items-center gap-2 text-xs leading-4 text-muted"><span>{text}</span>{children}</span>;
}

function LinkButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="border-0 bg-transparent p-0 text-xs leading-4 font-bold text-brand underline cursor-pointer"
    >
      {children}
    </button>
  );
}
