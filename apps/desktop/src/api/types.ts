/** Shapes from docs/api.md. Quantities are decimal strings. */

export interface Page<T> { items: T[]; total: number }
export interface Accepted { message_id: string; wms_id: string; status: "created" | "updated" | "accepted" }

export interface SessionUser {
  wms_id: string; username: string; display_name: string; role: string; warehouses: string[];
}
export interface Me extends SessionUser { scopes: string[]; kind: "user" | "api_client" }

export interface Site { wms_id: string; code: string; name: string; timezone: string; active: boolean }
export interface WarehouseSettings {
  erp_counts_gr: boolean; batch_from_production_order: boolean;
  receipt_tolerance_pct: number; supplier_tolerance_pct: number;
  allow_ship_short: boolean; supervisor_for_short_pick: boolean;
  auto_pick_mode: "single" | "batch" | "auto"; batch_pick_max_orders: number;
  idle_logout_minutes: number; pin_lockout_tries: number; known_devices_only: boolean;
  queue_offline_confirmations: boolean; fifo_by_received_date: boolean; blind_counts: boolean;
  decimals_allowed: boolean;
  multi_owner: boolean;
  gs1_company_prefix: string | null; sscc_extension_digit: number;
  platen_url: string | null; retry_failed_print_jobs: boolean;
  default_copies: number; ledger_retention_years: number; duplicate_window_hours: number;
  allow_hard_deletes: boolean;
}
export interface Warehouse {
  wms_id: string; code: string; site: string; name: string;
  /** The site's clock. Times are shown on it, not on the reader's. */
  timezone?: string | null;
  settings: WarehouseSettings; active: boolean;
}
export interface Zone { wms_id: string; warehouse: string; code: string; name: string; kind: string; active: boolean }
export interface Location {
  wms_id: string; warehouse: string; code: string; zone: string;
  type: "shelf" | "floor" | "rack" | "dock" | "line_side" | "in_transit";
  access: "ground" | "step" | "forklift"; mixing: "mixed" | "single_sku" | "single_batch";
  capacity: string | null; capacity_uom: string | null; pick_sequence: number;
  barcode: string | null; active: boolean;
}
export interface Barcode { barcode: string; kind: "gtin" | "carton" | "supplier" | "other"; qty_per: string }
export interface Product {
  wms_id: string; owner: string; sku: string; name: string; uom: string;
  decimals_allowed: boolean; batch_tracked: boolean; preferred_zone: string | null;
  pickface_min: string | null; pickface_max: string | null; barcodes: Barcode[]; active: boolean;
}

export interface StockAtLocation {
  warehouse: string; location: string; zone: string; batch: string | null; owner: string;
  on_hand: string; reserved: string; available: string; received_at: string | null;
}
export interface StockBySku {
  sku: string; uom: string; total_on_hand: string; total_available: string; locations: StockAtLocation[];
}
export interface StockLine {
  sku: string; name: string; batch: string | null; owner: string; on_hand: string; reserved: string;
  available: string; uom: string; received_at: string | null;
}
export interface StockAtShelf { wms_id: string; warehouse: string; location: string; zone: string; stock: StockLine[] }
export interface LedgerRow {
  wms_id: string; at: string; movement_type: string; reason: string | null; warehouse: string;
  location: string; zone: string; sku: string; batch: string | null; owner: string;
  qty_change: string; uom: string; received_at: string | null; actor: string; device: string | null;
  task_id: string | null; external_ref: string | null; container_id: string | null; note: string | null;
}

export interface ApiClientRow {
  wms_id: string; name: string; key_prefix: string; scopes: string[]; warehouses: string[]; owner: string;
  ip_allowlist: string[]; active: boolean; created_at: string; rotated_at: string | null;
  last_used_at: string | null; duplicates_24h: number; last_duplicate_at: string | null; key?: string;
}
export interface Subscriber {
  wms_id: string; name: string; url: string; event_types: string[]; warehouses: string[]; owner: string;
  active: boolean; created_at: string; status: "idle" | "ok" | "retrying" | "failed";
  last_delivery_at: string | null; pending: number; failed: number; secret?: string;
}
export interface OutboundEvent {
  wms_id: string; event_id: string; event_type: string; subscriber: string; warehouse: string | null;
  owner: string; external_ref: string | null; occurred_at: string; status: "pending" | "delivered" | "failed";
  attempts: number; next_attempt_at: string | null; last_error: string | null; delivered_at: string | null;
}

export interface User {
  wms_id: string; username: string; display_name: string; email: string | null; role: string;
  warehouses: string[]; owner: string; active: boolean; two_factor: boolean; locked: boolean;
  created_at: string; last_login_at: string | null;
}
export interface Operator {
  wms_id: string; code: string; name: string; badge: string | null; roles: string[]; warehouses: string[];
  active: boolean; locked: boolean; failed_attempts: number; created_at: string;
}
export interface Device {
  wms_id: string; code: string; name: string; warehouse: string | null; active: boolean;
  last_seen_at: string | null; created_at: string;
}
export interface AuditRow {
  wms_id: string; at: string; actor_type: string; actor: string; action: string; target_type: string | null;
  target: string | null; device: string | null; ip: string | null; detail: Record<string, unknown>;
}

/* --- step 2: tasks and inbound ------------------------------------------ */

export type TaskStatus = "waiting" | "in_progress" | "needs_supervisor" | "done" | "cancelled";
export type LineStatus = "open" | "done" | "short" | "variance" | "cancelled";

export interface TaskLine {
  line_no: number; source_line: number | null; sku: string; name: string; batch: string | null;
  expected_qty: string | null; actual_qty: string | null; variance: string | null; uom: string;
  from_location: string | null; to_location: string | null; container_id: string | null;
  status: LineStatus; reason: string | null; completed_at: string | null;
}
export interface Task {
  wms_id: string; type: string; title: string; status: TaskStatus; warehouse: string; owner: string;
  priority: "low" | "normal" | "high"; source_type: string | null; source_ref: string | null;
  assigned_to: string | null; device: string | null; needs_supervisor: boolean; note: string | null;
  created_by: string | null; created_at: string; started_at: string | null; completed_at: string | null;
  cancelled_at: string | null; progress: { done: number; total: number }; lines: TaskLine[];
}
export interface TaskReply extends Accepted { task: Task; line: TaskLine | null }

export interface ReceiptLine {
  line: number; sku: string; name: string; batch: string | null; expected_qty: string; received_qty: string; uom: string;
}
export interface Putaway {
  ledger_id: string; at: string; sku: string; batch: string | null; qty: string; uom: string; location: string;
  actor: string; device: string | null;
}
export interface Receipt {
  wms_id: string; external_ref: string; owner: string; warehouse: string; supplier: string | null; kind: string;
  expected_at: string | null; dock: string | null; carrier: string | null;
  status: "expected" | "arrived" | "receiving" | "complete" | "closed_short" | "cancelled";
  note: string | null; created_at: string; arrived_at: string | null; closed_at: string | null;
  expected_total: string; received_total: string; lines: ReceiptLine[]; task: Task | null;
  putaways: Putaway[]; events: { event_type: string; subscriber: string; status: string; at: string }[];
}

export interface ImportPreviewRow { row: number; problem: string | null; data: Record<string, string> }
export interface ImportResult {
  message_id: string; type: string; rows_read: number; ready: number; problems: number; committed: boolean;
  imported: number; summary: string; preview: ImportPreviewRow[];
}
export interface ScanResult {
  raw: string; format: string; type: string; fields: Record<string, string>;
  resolved: Record<string, unknown> | null; matches_expected: boolean | null; message: string | null;
}

/* --- step 3: deliveries ------------------------------------------------- */

export interface ShipTo {
  name: string; address?: string | null; suburb?: string | null; state?: string | null;
  postcode?: string | null; country?: string | null; contact?: string | null;
  phone?: string | null; email?: string | null;
}
export interface DeliveryLine {
  delivery_line: number; sku: string; name: string; batch: string | null;
  qty_ordered: string; qty_allocated: string; qty_picked: string; qty_shipped: string;
  uom: string; short_reason: string | null;
}
export interface PackageLine { delivery_line: number; sku: string; batch: string | null; qty: string; uom: string }
export interface DeliveryPackage {
  package_no: number; type: string; container_id: string | null; sscc: string | null;
  weight_kg: string | null; length_cm: string | null; width_cm: string | null; height_cm: string | null;
  packed_by: string | null; created_at: string; lines: PackageLine[];
}
export type DeliveryStatus =
  | "new" | "allocated" | "picking" | "picked" | "packing" | "packed" | "shipped" | "cancelled";
export interface Delivery {
  wms_id: string; external_ref: string; owner: string; warehouse: string; pick_mode: string;
  priority: "low" | "normal" | "high"; required_by: string | null; ship_to: ShipTo;
  carrier_hint: string | null; carrier: string | null; tracking_no: string | null;
  allow_short: boolean; status: DeliveryStatus; short: boolean; staging_location: string | null;
  note: string | null; created_at: string; allocated_at: string | null; picked_at: string | null;
  packed_at: string | null; shipped_at: string | null; cancelled_at: string | null;
  lines: DeliveryLine[]; packages: DeliveryPackage[]; task: Task | null; pack_task: Task | null;
  events: { event_type: string; subscriber: string; status: string; at: string }[];
}
export interface AllocationRow {
  delivery_line: number; sku: string; qty_ordered: string; qty_allocated: string; uom: string; short: string;
}
export interface DeliveryAccepted extends Accepted { allocation: AllocationRow[] }

export type ShortReason =
  | "not_found" | "short_on_shelf" | "damaged" | "location_unreadable" | "customer_cancelled";

/* --- step 4: printing --------------------------------------------------- */

export interface PrintTemplate {
  template: string; version: string; fields: string[]; fires_on: string[]; describe: string;
}
export interface PrintPoint {
  wms_id: string; warehouse: string | null; event_type: string; template: string; version: string;
  printer: string; copies: number; owner: string; active: boolean;
  created_at: string; updated_at: string | null;
}
export type PrintJobStatus = "pending" | "accepted" | "printed" | "failed";
export interface PrintJob {
  wms_id: string; job_id: string; warehouse: string | null; owner: string; template: string;
  version: string; printer: string; copies: number; reference: Record<string, unknown>;
  data: Record<string, unknown>; status: PrintJobStatus; attempts: number;
  next_attempt_at: string | null; last_error: string | null; external_ref: string | null;
  reprint_of: string | null; created_at: string; sent_at: string | null; printed_at: string | null;
}

/* --- step 5: transfers, production, batch picking ----------------------- */

export type TransferStatus =
  | "new" | "allocated" | "picking" | "picked" | "in_transit" | "receiving"
  | "received" | "variance" | "closed" | "cancelled";
export interface TransferLine {
  line: number; sku: string; name: string; batch: string | null;
  qty_requested: string; qty_allocated: string; qty_picked: string; qty_shipped: string;
  qty_received: string; variance: string; uom: string;
}
export interface Transfer {
  wms_id: string; external_ref: string; owner: string; from_warehouse: string; to_warehouse: string;
  required_by: string | null; priority: "low" | "normal" | "high"; carrier_hint: string | null;
  carrier: string | null; tracking_no: string | null; status: TransferStatus;
  staging_location: string | null; in_transit_location: string | null; note: string | null;
  variance_reason: string | null; created_at: string; allocated_at: string | null;
  shipped_at: string | null; received_at: string | null; closed_at: string | null;
  cancelled_at: string | null; lines: TransferLine[]; pick_task: Task | null; receive_task: Task | null;
}

export type ProductionStatus = "new" | "issuing" | "in_production" | "complete" | "cancelled";
export interface ProductionOutput {
  sku: string; name: string; batch: string | null; qty: string; qty_received: string; uom: string;
}
export interface ProductionComponent {
  line: number; sku: string; name: string; batch: string | null; qty_requested: string;
  qty_issued: string; short: string; uom: string; deliver_to: string;
}
export interface ProductionPallet {
  wms_id: string; sku: string; batch: string | null; qty: string; uom: string; location: string;
  container_id: string | null; operator: string | null; device: string | null;
  supervisor: string | null; event_sent: boolean; created_at: string;
}
export interface ProductionOrder {
  wms_id: string; external_ref: string; owner: string; warehouse: string; required_by: string | null;
  priority: "low" | "normal" | "high"; status: ProductionStatus; note: string | null;
  created_at: string; issued_at: string | null; completed_at: string | null;
  cancelled_at: string | null; output: ProductionOutput; components: ProductionComponent[];
  receipts: ProductionPallet[]; issue_task: Task | null;
}

export interface BatchTote {
  tote: string; delivery: string; ship_to: string | null; status: DeliveryStatus; lines: number;
}
export interface BatchPick { tote: string; delivery: string; qty: string }
export interface BatchStop {
  stop: number; location: string; zone: string; pick_sequence: number; sku: string; name: string;
  batch: string | null; qty: string; uom: string; picks: BatchPick[];
}
export interface PickBatch {
  wms_id: string; external_ref: string; owner: string; warehouse: string;
  status: "new" | "picking" | "picked" | "cancelled"; assigned_to: string | null; note: string | null;
  created_by: string | null; created_at: string; started_at: string | null;
  completed_at: string | null; cancelled_at: string | null; orders: number; lines: number;
  stops: BatchStop[]; done_stops: number; totes: BatchTote[];
}
export interface BatchSuggestion {
  zone: string; deliveries: string[]; orders: number; lines: number; stops: number; saved: number;
}
export interface StopConfirmed extends Accepted {
  picked: string; picks: BatchPick[]; batch_status: string; stops_left: number;
}

/* --- step 6: containers, owners, reports -------------------------------- */

export type ContainerType = "pallet" | "carton" | "tote" | "cage";
export interface ContainerContent {
  sku: string; name: string; batch: string | null; qty: string; uom: string;
  container_id: string; received_at: string | null;
}
export interface ContainerChild {
  container_id: string; type: ContainerType; sscc: string | null; status: string;
}
export interface Container {
  wms_id: string; container_id: string; sscc: string | null; owner: string; type: ContainerType;
  warehouse: string; location: string | null; parent: string | null;
  status: "open" | "closed" | "shipped" | "retired"; weight_kg: string | null; note: string | null;
  created_at: string; closed_at: string | null; children: ContainerChild[];
  contents: ContainerContent[]; total_qty: string;
}

export interface Owner {
  wms_id: string; code: string; name: string; contact: string | null; email: string | null;
  phone: string | null; settings: Record<string, unknown>; note: string | null; active: boolean;
  created_at: string;
}

export interface ReportListing { report: string; describe: string; filters: string[] }
export interface ReportResult {
  report: string; warehouse: string; owner: string; from: string | null; to: string | null;
  describe: string; columns: string[]; rows: Record<string, string | number | null>[];
  totals: Record<string, string | number>;
}
