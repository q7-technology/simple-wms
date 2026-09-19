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
  decimals_allowed: boolean; platen_url: string | null; retry_failed_print_jobs: boolean;
  default_copies: number; ledger_retention_years: number; duplicate_window_hours: number;
  allow_hard_deletes: boolean;
}
export interface Warehouse {
  wms_id: string; code: string; site: string; name: string; settings: WarehouseSettings; active: boolean;
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
  warehouses: string[]; active: boolean; two_factor: boolean; created_at: string; last_login_at: string | null;
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
