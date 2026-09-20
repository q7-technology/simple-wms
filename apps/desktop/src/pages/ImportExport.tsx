import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { ImportPreviewRow, ImportResult } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { plural } from "../lib/format";
import { useAction } from "../lib/useApi";
import {
  Button, Card, Chip, Eyebrow, Field, Muted, Notice, PageHeader, Section, StatTile, Table, Toggle, type Column,
} from "../ui";
import { Main } from "../ui/Shell";

type ImportType = "receipts" | "products" | "locations";

const IMPORT_AS: { value: string; label: string; step?: number }[] = [
  { value: "deliveries", label: "Deliveries (pick orders)", step: 3 },
  { value: "receipts", label: "Expected receipts" },
  { value: "products", label: "Products" },
  { value: "locations", label: "Locations" },
  { value: "replenishments", label: "Replenishments", step: 3 },
  { value: "transfers", label: "Transfers", step: 5 },
];
const TEMPLATES: ImportType[] = ["receipts", "products", "locations"];
const HEADERS: Record<string, string> = { sku: "SKU", uom: "UOM", qty: "Qty", gtin: "GTIN" };
const MAX_DATA_COLUMNS = 4;

function headerLabel(key: string): string {
  if (HEADERS[key]) return HEADERS[key];
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Data rows in a CSV: non-empty lines less the header. */
function countRows(csv: string): number {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
}

function toCsv(rows: ImportPreviewRow[]): string {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.data)))];
  const head = [...keys, "problem"].join(",");
  const body = rows.map((r) => [...keys.map((k) => csvCell(r.data[k] ?? "")), csvCell(r.problem ?? "")].join(","));
  return [head, ...body].join("\n") + "\n";
}

/** Hand the browser a file to save. */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Templates are plain text behind the bearer token, so fetch by hand. */
async function downloadTemplate(type: ImportType) {
  const res = await fetch(`/v1/imports/templates/${type}`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${api.session?.token ?? ""}` },
  });
  if (!res.ok) throw new Error(`Could not fetch the ${type} template (HTTP ${res.status})`);
  saveText(`${type}.csv`, await res.text());
}

export function ImportExport() {
  const { warehouse, warehouses } = useAuth();
  const [csv, setCsv] = useState("");
  const [file, setFile] = useState<{ name: string; rows: number; kb: number } | null>(null);
  const [type, setType] = useState<ImportType | null>(null);
  const [warehouseCode, setWarehouseCode] = useState<string>(warehouse?.code ?? "");
  const [skipProblems, setSkipProblems] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const preview = useAction();
  const commit = useAction();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!warehouseCode && warehouse?.code) setWarehouseCode(warehouse.code);
  }, [warehouse, warehouseCode]);

  const pasteRows = useMemo(() => (file ? null : countRows(csv)), [csv, file]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setCsv(text);
      setFile({ name: f.name, rows: countRows(text), kb: Math.max(1, Math.round(f.size / 1024)) });
      setResult(null);
      setImported(null);
    };
    reader.readAsText(f);
  };

  const clearAll = () => {
    setCsv("");
    setFile(null);
    setResult(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const body = (dryRun: boolean) => ({
    warehouse: warehouseCode, owner: "DEFAULT", csv, dry_run: dryRun, skip_problems: skipProblems,
  });

  const runPreview = async () => {
    if (!type) return;
    setImported(null);
    commit.clear();
    const out = await preview.run(() => api.message<ImportResult>(`/v1/imports/${type}`, body(true)));
    if (out) setResult(out);
  };

  const runImport = async () => {
    if (!type || !result) return;
    const out = await commit.run(() => api.message<ImportResult>(`/v1/imports/${type}`, body(false)));
    if (out) {
      setImported(`Imported ${plural(out.imported, "row")}${out.summary ? ` ${out.summary}` : ""}`);
      clearAll();
    }
  };

  const previewRows = useMemo(() => {
    const rows = result?.preview ?? [];
    return [...rows.filter((r) => r.problem), ...rows.filter((r) => !r.problem)];
  }, [result]);
  const problemRows = previewRows.filter((r) => r.problem);
  const dataKeys = Object.keys(previewRows[0]?.data ?? {}).slice(0, MAX_DATA_COLUMNS);

  const columns: Column<ImportPreviewRow>[] = [
    { key: "row", header: "Row", width: "70px", render: (r) => String(r.row) },
    ...dataKeys.map<Column<ImportPreviewRow>>((k) => ({
      key: k, header: headerLabel(k), width: "minmax(80px, 150px)", render: (r) => r.data[k] ?? <Muted>—</Muted>,
    })),
    { key: "problem", header: "Problem", render: (r) => (r.problem ? <span className="text-gold">{r.problem}</span> : <Muted>OK</Muted>) },
  ];

  const canPreview = Boolean(type && csv.trim() && warehouseCode) && !preview.busy;

  return (
    <Main>
      <PageHeader
        eyebrow="CSV fallback"
        accent="Import"
        title="and export"
        actions={<>
          <Button variant="gold" disabled title="Reports come with step 6">Export stock on hand</Button>
          <Button variant="gold" disabled title="Reports come with step 6">Export movements</Button>
        </>}
      />

      <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6 grow min-h-0 items-start">
        {/* --- left: upload and templates --- */}
        <div className="flex flex-col gap-4">
          <Card className="p-5 flex flex-col gap-4">
            <Eyebrow tone="muted">Upload</Eyebrow>
            <div className="flex items-center gap-3 py-3 row-line">
              <div className="flex flex-col gap-0.5 grow min-w-0">
                {file ? (
                  <>
                    <span className="text-sm leading-5 truncate">{file.name}</span>
                    <Muted className="text-xs leading-4">{plural(file.rows, "row")} · {file.kb} KB</Muted>
                  </>
                ) : (
                  <>
                    <span className="text-sm leading-5">No file chosen</span>
                    <Muted className="text-xs leading-4">{pasteRows ? `${plural(pasteRows, "row")} pasted` : "CSV, UTF-8, header row first"}</Muted>
                  </>
                )}
              </div>
              <Button small onClick={() => fileInput.current?.click()}>{file ? "Replace" : "Choose file"}</Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                className="sr-only"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
            <Field label="or paste CSV">
              <textarea
                aria-label="or paste CSV"
                className="input !h-28 py-2 resize-y mono text-xs"
                value={csv}
                placeholder={"sku,name,uom\nABC123,Brake pad set,EA"}
                onChange={(e) => { setCsv(e.target.value); setFile(null); setResult(null); setImported(null); if (fileInput.current) fileInput.current.value = ""; }}
              />
            </Field>
            <Field label="Import as">
              <div className="flex gap-1 flex-wrap">
                {IMPORT_AS.map((t) => t.step ? (
                  <span key={t.value} title={`Step ${t.step}`} className="opacity-50 cursor-not-allowed inline-flex">
                    <Chip>{t.label}</Chip>
                  </span>
                ) : (
                  <Chip key={t.value} active={type === t.value} onClick={() => { setType(t.value as ImportType); setResult(null); }}>{t.label}</Chip>
                ))}
              </div>
            </Field>
            <Field label="Warehouse">
              <div className="flex gap-1 flex-wrap">
                {warehouses.length === 0 && <Muted className="text-xs">No warehouses yet</Muted>}
                {warehouses.map((w) => (
                  <Chip key={w.code} active={warehouseCode === w.code} onClick={() => { setWarehouseCode(w.code); setResult(null); }}>{w.code}</Chip>
                ))}
              </div>
            </Field>
            <Toggle
              checked={skipProblems}
              onChange={setSkipProblems}
              label="Skip rows with problems"
              hint="Import the good rows, report the rest"
            />
            {preview.error && <Notice tone="gold">{preview.error}</Notice>}
            <Button variant="primary" onClick={() => void runPreview()} disabled={!canPreview}>
              {preview.busy ? "Checking…" : "Preview"}
            </Button>
          </Card>

          <Card className="p-5 flex flex-col gap-3">
            <Eyebrow tone="muted">Template files</Eyebrow>
            <div className="flex flex-col rounded-lg border border-line">
              {TEMPLATES.map((t) => (
                <div key={t} className="flex justify-between items-center px-3 py-2.5 text-sm leading-5 row-line last:border-b-0">
                  <span className="mono">{t}.csv</span>
                  <button
                    type="button"
                    className="bg-transparent border-0 p-0 text-brand hover:text-[#64ffda] cursor-pointer text-sm"
                    onClick={() => { setTemplateError(null); downloadTemplate(t).catch((e: Error) => setTemplateError(e.message)); }}
                  >
                    download
                  </button>
                </div>
              ))}
            </div>
            {templateError && <Notice tone="gold">{templateError}</Notice>}
            <Muted className="text-xs leading-4">Header row first. Quantities are decimals with a unit of measure.</Muted>
          </Card>
        </div>

        {/* --- right: preview --- */}
        <div className="flex flex-col gap-4 min-w-0">
          {imported && <Notice tone="ok">{imported}</Notice>}
          {commit.error && <Notice tone="gold">{commit.error}</Notice>}
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <StatTile label="Rows read" value={String(result.rows_read)} hint={file?.name ?? "pasted CSV"} />
                <StatTile label="Ready to import" value={String(result.ready)} hint={result.summary || "rows"} />
                <StatTile label="Rows with problems" value={String(result.problems)} tone={result.problems > 0 ? "gold" : undefined} hint={result.problems > 0 ? "fix or skip" : "none"} />
              </div>
              <Section title="Preview · problems first">
                <Table
                  columns={columns}
                  rows={previewRows}
                  rowKey={(r) => String(r.row)}
                  empty="Nothing to preview. The file has a header row and no data."
                />
                {!skipProblems && result.problems > 0 && (
                  <Notice tone="gold">Skip is off: with {plural(result.problems, "problem")} the import is refused and nothing is written.</Notice>
                )}
                <div className="flex gap-2 justify-end">
                  <Button onClick={() => saveText(`${type ?? "import"}-problems.csv`, toCsv(problemRows))} disabled={problemRows.length === 0}>
                    Download problem rows
                  </Button>
                  <Button variant="primary" onClick={() => void runImport()} disabled={commit.busy || result.ready === 0}>
                    {commit.busy ? "Importing…" : `Import ${plural(result.ready, "row")}`}
                  </Button>
                </div>
              </Section>
            </>
          ) : (
            !imported && (
              <Muted className="text-sm leading-5">
                Choose a file or paste CSV, say what it is and press Preview. The preview checks every row and writes nothing;
                nothing is written until Import is pressed.
              </Muted>
            )
          )}
        </div>
      </div>
    </Main>
  );
}
