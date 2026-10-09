"""Demo data: two warehouses with a working day already in them.

Everything goes through the API, in process, with a key made for the run and
revoked at the end. So the stock arrives by receive tasks, leaves by pick,
pack and ship, and the ledger holds exactly what a real day would leave
behind. Nothing here writes a table directly.

The names match the Game Mode design: a safety-supplies catalogue, the
Ballarat and Melbourne warehouses, and the people on the Users screen.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import select

from wms.db import get_sessionmaker
from wms.models import Warehouse
from wms.services import access

PASSWORD = "demo-password-1"
PIN = "1234"

SITES = [("BAL", "Ballarat"), ("MEL", "Melbourne")]

WAREHOUSES = [
    ("BAL-WH01", "BAL", "Ballarat", {"receipt_tolerance_pct": 5, "allow_ship_short": True}),
    ("MEL-WH01", "MEL", "Melbourne", {"receipt_tolerance_pct": 5, "allow_ship_short": True}),
]

ZONES = {
    "BAL-WH01": [("RECEIVE", "Receiving dock", "staging"), ("BULK", "Bulk", "bulk"),
                 ("PICKFACE", "Pick face", "pickface"), ("PACK", "Packing", "packing"),
                 ("IN-TRANSIT", "In transit", "in_transit")],
    "MEL-WH01": [("RECEIVE", "Receiving dock", "staging"), ("BULK", "Bulk", "bulk"),
                 ("PICKFACE", "Pick face", "pickface"), ("PACK", "Packing", "packing"),
                 ("IN-TRANSIT", "In transit", "in_transit")],
}

# (code, zone, type, access, pick_sequence)
LOCATIONS = {
    "BAL-WH01": [
        ("DOCK-01", "RECEIVE", "dock", "ground", 10),
        ("DOCK-02", "RECEIVE", "dock", "ground", 20),
        ("PF-01-02-A", "PICKFACE", "shelf", "ground", 120),
        ("PF-01-03-B", "PICKFACE", "shelf", "ground", 130),
        ("PF-01-05-C", "PICKFACE", "shelf", "step", 150),
        ("PF-01-06-A", "PICKFACE", "shelf", "ground", 160),
        ("PF-01-10-B", "PICKFACE", "shelf", "ground", 200),
        ("PF-01-12-C", "PICKFACE", "shelf", "step", 220),
        ("BK-02-03-B", "BULK", "rack", "forklift", 230),
        ("BK-04-01-C", "BULK", "rack", "forklift", 410),
        ("BK-04-02-A", "BULK", "rack", "forklift", 420),
        ("BK-05-01-A", "BULK", "rack", "forklift", 510),
        ("BK-05-02-B", "BULK", "rack", "forklift", 520),
        ("PACK-01", "PACK", "floor", "ground", 900),
        ("PACK-02", "PACK", "floor", "ground", 910),
        ("BAL-TRANSIT", "IN-TRANSIT", "in_transit", "ground", 0),
    ],
    "MEL-WH01": [
        ("MEL-DOCK-01", "RECEIVE", "dock", "ground", 10),
        ("PF-02-01-B", "PICKFACE", "shelf", "ground", 110),
        ("PF-02-02-A", "PICKFACE", "shelf", "ground", 120),
        ("MB-01-01-A", "BULK", "rack", "forklift", 310),
        ("MB-01-02-A", "BULK", "rack", "forklift", 320),
        ("MEL-PACK-01", "PACK", "floor", "ground", 900),
        ("MEL-TRANSIT", "IN-TRANSIT", "in_transit", "ground", 0),
    ],
}

# (sku, name, uom, decimals, batch_tracked, preferred_zone, min, max, gtin)
PRODUCTS = [
    ("GLV-L", "Safety gloves (L)", "PR", False, False, "PICKFACE", 40, 120, "09312345000012"),
    ("VST-HV", "Hi-vis vests", "EA", False, False, "PICKFACE", 20, 60, "09312345000029"),
    ("HAT-WH", "Hard hats (white)", "EA", False, False, "PICKFACE", 12, 36, "09312345000036"),
    ("TPE-48", "Packing tape 48 mm", "RL", False, False, "PICKFACE", 24, 72, "09312345000043"),
    ("BOX-LG", "Cardboard boxes (large)", "EA", False, False, "BULK", None, None, "09312345000050"),
    ("WRP-500", "Pallet wrap 500 mm", "RL", False, False, "PICKFACE", 12, 36, "09312345000067"),
    ("EAR-200", "Ear plugs (box of 200)", "BX", False, True, "PICKFACE", 10, 40, "09312345000074"),
    ("TIE-300", "Cable ties 300 mm", "PK", False, False, "PICKFACE", 20, 80, "09312345000081"),
    ("BOOT-10", "Work boots (size 10)", "PR", False, False, "PICKFACE", 6, 18, "09312345000098"),
    ("AID-KIT", "First aid kits", "EA", False, True, "PICKFACE", 6, 24, "09312345000104"),
    ("ROPE-12", "Rope 12 mm", "M", True, False, "BULK", None, None, "09312345000111"),
]

USERS = [
    ("admin", "Alex R.", "admin", ["*"]),
    ("kim", "Kim R.", "supervisor", ["BAL-WH01"]),
    ("priya.n", "Priya N.", "inventory_controller", ["BAL-WH01", "MEL-WH01"]),
]

# (code, name, badge, roles, warehouses)
OPERATORS = [
    ("sup-004", "Kim R.", "0007", ["supervisor"], ["BAL-WH01", "MEL-WH01"]),
    ("op-017", "Sam K.", "0042", ["picker", "packer"], ["BAL-WH01"]),
    ("op-019", "Priya N.", "0047", ["picker", "counter"], ["BAL-WH01"]),
    ("op-021", "Jo M.", "0051", ["receiver"], ["BAL-WH01"]),
    ("op-022", "Ben T.", "0055", ["picker"], ["BAL-WH01"]),
    ("op-031", "Mia W.", "0061", ["receiver", "picker", "packer"], ["MEL-WH01"]),
]

DEVICES = [
    ("SCN-BAL-07", "Ballarat scanner 7", "BAL-WH01"),
    ("SCN-BAL-08", "Ballarat scanner 8", "BAL-WH01"),
    ("SCN-MEL-01", "Melbourne scanner 1", "MEL-WH01"),
]

CUSTOMERS = {
    "2044": ("Westgate Plumbing", "8 Station Rd", "Melton", "3337"),
    "2045": ("Oakwood School", "1 School Ln", "Creswick", "3363"),
    "2047": ("Ridgeline Hardware", "220 Sturt St", "Ballarat", "3350"),
    "2048": ("Lakeside Cafe Supplies", "14 Mitchell St", "Bendigo", "3550"),
    "2049": ("Northside Builders", "77 Corio St", "Geelong", "3220"),
    "2050": ("Green Valley Garden Co", "5 Vincent St", "Daylesford", "3460"),
    "2051": ("Harbour Safety Gear", "300 Lorimer St", "Port Melbourne", "3207"),
    "2052": ("Sunrise Bakery", "61 Barkly St", "Ararat", "3377"),
}


class SeedError(Exception):
    pass


class Seeder:
    def __init__(self, client: TestClient, key: str, today: date):
        self.c = client
        self.h = {"Authorization": f"Bearer {key}"}
        self.today = today

    def post(self, path: str, body: dict, *, envelope: bool = True) -> dict:
        if envelope:
            body = {"message_id": str(uuid.uuid4()), **body}
        r = self.c.post(f"/v1{path}", headers=self.h, json=body)
        if r.status_code >= 300:
            raise SeedError(f"POST {path} -> {r.status_code}: {r.text}")
        return r.json() if r.content else {}

    def get(self, path: str, **params) -> dict:
        r = self.c.get(f"/v1{path}", headers=self.h, params=params)
        if r.status_code >= 300:
            raise SeedError(f"GET {path} -> {r.status_code}: {r.text}")
        return r.json()

    def day(self, offset: int) -> str:
        return (self.today + timedelta(days=offset)).isoformat()

    def task(self, warehouse: str, source_ref: str, type: str) -> dict:
        items = self.get("/tasks", warehouse=warehouse, source_ref=source_ref, type=type)["items"]
        if not items:
            raise SeedError(f"no {type} task for {source_ref} at {warehouse}")
        return items[-1]

    # --- master data -------------------------------------------------------

    def master_data(self) -> None:
        for code, name in SITES:
            self.post("/sites", {"code": code, "name": name, "timezone": "Australia/Melbourne"})
        for code, site, name, settings in WAREHOUSES:
            self.post("/warehouses", {"code": code, "site": site, "name": name, "settings": settings})
        for wh, zones in ZONES.items():
            for code, name, kind in zones:
                self.post("/zones", {"warehouse": wh, "code": code, "name": name, "kind": kind})
        for wh, locs in LOCATIONS.items():
            for code, zone, type_, access_, seq in locs:
                self.post("/locations", {
                    "warehouse": wh, "code": code, "zone": zone, "type": type_, "access": access_,
                    "mixing": "mixed", "pick_sequence": seq, "barcode": f"LOC-{code}", "active": True,
                })
        for sku, name, uom, decimals, batched, zone, lo, hi, gtin in PRODUCTS:
            self.post("/products", {
                "owner": "DEFAULT", "sku": sku, "name": name, "uom": uom,
                "decimals_allowed": decimals, "batch_tracked": batched, "preferred_zone": zone,
                "pickface_min": lo, "pickface_max": hi,
                "barcodes": [{"barcode": gtin, "kind": "gtin"}], "active": True,
            })
        self.post("/batches", {"sku": "EAR-200", "code": "B2601", "expiry_date": self.day(540)})
        self.post("/batches", {"sku": "EAR-200", "code": "B2609", "expiry_date": self.day(720)})
        self.post("/batches", {"sku": "AID-KIT", "code": "K2604", "expiry_date": self.day(365)})

    def people(self) -> None:
        for username, name, role, whs in USERS:
            self.post("/users", {"username": username, "display_name": name, "role": role,
                                 "warehouses": whs, "password": PASSWORD}, envelope=False)
        for code, name, badge, roles, whs in OPERATORS:
            self.post("/operators", {"code": code, "name": name, "pin": PIN, "badge": badge,
                                     "roles": roles, "warehouses": whs}, envelope=False)
        for code, name, wh in DEVICES:
            self.post("/devices", {"code": code, "name": name, "warehouse": wh}, envelope=False)

    # --- inbound -----------------------------------------------------------

    def receipt(self, ref: str, wh: str, supplier: str, due: int, lines: list[tuple]) -> None:
        self.post("/receipts", {
            "external_ref": ref, "warehouse": wh, "owner": "DEFAULT", "supplier": supplier,
            "expected_at": self.day(due),
            "lines": [{"line": i, "sku": sku, "batch": batch, "qty": qty, "uom": uom}
                      for i, (sku, qty, uom, batch, _) in enumerate(lines, 1)],
        })

    def receive(self, ref: str, wh: str, lines: list[tuple], *, upto: int | None = None,
                operator: str = "op-021", device: str = "SCN-BAL-07") -> None:
        """Receive lines in full. Each line's put-away is a list of (location, qty)."""
        self.post(f"/receipts/{ref}/arrived", {"warehouse": wh, "dock": LOCATIONS[wh][0][0],
                                               "carrier": "Ridgeway Freight"})
        task = self.task(wh, ref, "receive")
        self.post(f"/tasks/{task['wms_id']}/start", {"operator": operator, "device": device})
        for i, (sku, _, uom, batch, putaway) in enumerate(lines[:upto], 1):
            for loc, qty in putaway:
                self.post(f"/tasks/{task['wms_id']}/lines/{i}/confirm", {
                    "qty": qty, "uom": uom, "batch": batch, "location": loc,
                    "operator": operator, "device": device,
                })

    def inbound(self) -> None:
        stock_in = [
            ("PO-88801", "Supplier Co", -14, [
                ("GLV-L", 200, "PR", None, [("BK-04-01-C", 120), ("PF-01-02-A", 80)]),
                ("VST-HV", 90, "EA", None, [("BK-04-02-A", 50), ("PF-01-03-B", 40)]),
                ("HAT-WH", 72, "EA", None, [("BK-05-01-A", 48), ("PF-01-05-C", 24)]),
            ]),
            ("PO-88804", "Packright Packaging", -10, [
                ("BOX-LG", 600, "EA", None, [("BK-02-03-B", 600)]),
                ("TPE-48", 48, "RL", None, [("PF-01-06-A", 48)]),
                ("WRP-500", 24, "RL", None, [("PF-01-10-B", 24)]),
                ("TIE-300", 80, "PK", None, [("BK-05-02-B", 40), ("PF-01-12-C", 40)]),
            ]),
            ("PO-88807", "SafeWorks AU", -6, [
                ("EAR-200", 30, "BX", "B2601", [("PF-01-12-C", 30)]),
                ("EAR-200", 20, "BX", "B2609", [("BK-05-02-B", 20)]),
                ("BOOT-10", 12, "PR", None, [("PF-01-05-C", 12)]),
                ("AID-KIT", 30, "EA", "K2604", [("PF-01-03-B", 30)]),
                ("ROPE-12", 250.5, "M", None, [("BK-04-02-A", 250.5)]),
            ]),
            ("PO-88812", "Supplier Co", -3, [
                ("GLV-L", 60, "PR", None, [("BK-04-01-C", 60)]),
                ("VST-HV", 40, "EA", None, [("BK-04-02-A", 40)]),
                ("HAT-WH", 24, "EA", None, [("BK-05-01-A", 24)]),
            ]),
        ]
        for ref, supplier, due, lines in stock_in:
            self.receipt(ref, "BAL-WH01", supplier, due, lines)
            self.receive(ref, "BAL-WH01", lines)

        self.receipt("MEL-1001", "MEL-WH01", "Supplier Co", -8, mel := [
            ("GLV-L", 100, "PR", None, [("MB-01-01-A", 60), ("PF-02-01-B", 40)]),
            ("VST-HV", 40, "EA", None, [("PF-02-02-A", 40)]),
            ("TPE-48", 36, "RL", None, [("MB-01-02-A", 36)]),
        ])
        self.receive("MEL-1001", "MEL-WH01", mel, operator="op-031", device="SCN-MEL-01")

        # Today's trucks, in every state the Receiving screen shows.
        partly = [
            ("GLV-L", 120, "PR", None, [("BK-04-01-C", 120)]),
            ("VST-HV", 120, "EA", None, []),
            ("HAT-WH", 100, "EA", None, []),
            ("TPE-48", 100, "RL", None, []),
            ("WRP-500", 40, "RL", None, []),
        ]
        self.receipt("PO-88815", "BAL-WH01", "Supplier Co", 0, partly)
        self.receive("PO-88815", "BAL-WH01", partly, upto=1)
        self.receipt("PO-88816", "BAL-WH01", "Brakes Direct", 0, [
            ("BOOT-10", 24, "PR", None, None), ("AID-KIT", 20, "EA", "K2604", None)])
        self.post("/receipts/PO-88816/arrived", {"warehouse": "BAL-WH01", "dock": "DOCK-02",
                                                 "carrier": "Ridgeway Freight"})
        self.receipt("PO-88817", "BAL-WH01", "Filters AU", 0, [
            ("TIE-300", 200, "PK", None, None), ("EAR-200", 40, "BX", None, None),
            ("BOX-LG", 400, "EA", None, None)])
        self.receipt("PO-88809", "BAL-WH01", "Rotor Works", -2, [("ROPE-12", 60, "M", None, None)])

    # --- outbound ----------------------------------------------------------

    def delivery(self, ref: str, due: int, lines: list[tuple], priority: str = "normal") -> None:
        name, address, suburb, postcode = CUSTOMERS[ref]
        self.post("/deliveries", {
            "external_ref": ref, "warehouse": "BAL-WH01", "owner": "DEFAULT", "pick_mode": "single",
            "priority": priority, "required_by": self.day(due),
            "ship_to": {"name": name, "address": address, "suburb": suburb, "state": "VIC",
                        "postcode": postcode, "country": "AU"},
            "carrier_hint": None, "allow_short": True,
            "lines": [{"delivery_line": 10 * i, "sku": sku, "batch": None, "qty": qty, "uom": uom}
                      for i, (sku, qty, uom) in enumerate(lines, 1)],
        })

    def pick(self, ref: str, wh: str = "BAL-WH01", type: str = "pick", *, upto: int | None = None,
             operator: str = "op-017", device: str = "SCN-BAL-07") -> None:
        task = self.task(wh, ref, type)
        self.post(f"/tasks/{task['wms_id']}/start", {"operator": operator, "device": device})
        for line in task["lines"][:upto]:
            self.post(f"/tasks/{task['wms_id']}/lines/{line['line_no']}/confirm", {
                "qty": line["expected_qty"], "uom": line["uom"], "operator": operator, "device": device,
            })

    def pack(self, ref: str, lines: list[tuple], path: str = "deliveries", key: str = "delivery_line",
             wh: str = "BAL-WH01") -> None:
        self.post(f"/{path}/{ref}/pack", {
            "warehouse": wh, "packed_by": "op-017", "complete": True,
            "packages": [{"package_no": 1, "type": "carton", "weight_kg": 9.5,
                          "length_cm": 60, "width_cm": 40, "height_cm": 40,
                          "lines": [{key: (10 * i if key == "delivery_line" else i), "sku": sku,
                                     "batch": batch, "qty": qty, "uom": uom}
                                    for i, (sku, qty, uom, batch) in enumerate(lines, 1)]}],
        })

    def ship(self, ref: str, path: str = "deliveries", carrier: str = "Toll",
             wh: str = "BAL-WH01") -> None:
        self.post(f"/{path}/{ref}/ship", {"warehouse": wh, "carrier": carrier,
                                          "tracking_no": f"{carrier.upper()}{ref}", "shipped_by": "op-017"})

    def outbound(self) -> None:
        # Shipped earlier today
        self.delivery("2044", -1, [("GLV-L", 20, "PR"), ("TPE-48", 6, "RL")])
        self.pick("2044")
        self.pack("2044", [("GLV-L", 20, "PR", None), ("TPE-48", 6, "RL", None)])
        self.ship("2044")
        self.delivery("2045", 0, [("AID-KIT", 4, "EA"), ("VST-HV", 10, "EA")])
        self.pick("2045", operator="op-022", device="SCN-BAL-08")
        self.pack("2045", [("AID-KIT", 4, "EA", "K2604"), ("VST-HV", 10, "EA", None)])
        self.ship("2045", carrier="StarTrack")

        # Packed, waiting on the truck
        self.delivery("2048", 0, [("BOX-LG", 50, "EA"), ("TIE-300", 10, "PK")], priority="high")
        self.pick("2048")
        self.pack("2048", [("BOX-LG", 50, "EA", None), ("TIE-300", 10, "PK", None)])

        # Half picked
        self.delivery("2049", 0, [("HAT-WH", 12, "EA"), ("VST-HV", 12, "EA"), ("GLV-L", 24, "PR")])
        self.pick("2049", operator="op-019", device="SCN-BAL-08", upto=1)

        # Allocated, nobody on them yet
        self.delivery("2047", 0, [("GLV-L", 30, "PR"), ("EAR-200", 5, "BX"), ("ROPE-12", 25.5, "M")])
        self.delivery("2051", 1, [("VST-HV", 20, "EA"), ("HAT-WH", 10, "EA"), ("AID-KIT", 6, "EA")])
        self.delivery("2050", 1, [("WRP-500", 6, "RL"), ("TIE-300", 20, "PK")], priority="low")
        # More boots than the shelf holds: allocated short until PO-88816 is put away
        self.delivery("2052", 3, [("BOOT-10", 16, "PR"), ("TPE-48", 4, "RL")])

    # --- transfers, replenishment, counts ----------------------------------

    def transfer(self, ref: str, frm: str, to: str, due: int, lines: list[tuple]) -> None:
        self.post("/transfers", {
            "external_ref": ref, "owner": "DEFAULT", "from_warehouse": frm, "to_warehouse": to,
            "required_by": self.day(due), "priority": "normal",
            "lines": [{"line": i, "sku": sku, "batch": batch, "qty": qty, "uom": uom}
                      for i, (sku, qty, uom, batch) in enumerate(lines, 1)],
        })

    def transfers(self) -> None:
        done = [("GLV-L", 20, "PR", None), ("TPE-48", 12, "RL", None)]
        self.transfer("STO-4500008", "BAL-WH01", "MEL-WH01", -2, done)
        self.pick("STO-4500008", type="transfer_pick")
        self.ship("STO-4500008", path="transfers", carrier="Ridgeway")
        task = self.task("MEL-WH01", "STO-4500008", "transfer_receive")
        self.post(f"/tasks/{task['wms_id']}/start", {"operator": "op-031", "device": "SCN-MEL-01"})
        for line in task["lines"]:
            self.post(f"/tasks/{task['wms_id']}/lines/{line['line_no']}/confirm", {
                "qty": line["expected_qty"], "uom": line["uom"], "batch": line["batch"],
                "location": "MB-01-02-A", "operator": "op-031", "device": "SCN-MEL-01",
            })

        self.transfer("STO-4500011", "BAL-WH01", "MEL-WH01", 1,
                      [("BOX-LG", 100, "EA", None), ("HAT-WH", 12, "EA", None)])
        self.pick("STO-4500011", type="transfer_pick", operator="op-022", device="SCN-BAL-08")
        self.ship("STO-4500011", path="transfers", carrier="Ridgeway")

        self.transfer("STO-4500012", "BAL-WH01", "MEL-WH01", 2, [("GLV-L", 40, "PR", None)])

    def housekeeping(self) -> None:
        # The pick face for hi-vis is low after today's picks: top it up from bulk.
        self.post("/replenishments", {
            "external_ref": "REP-1001", "warehouse": "BAL-WH01", "owner": "DEFAULT",
            "priority": "high",
            "lines": [{"line": 1, "sku": "VST-HV", "qty": 30, "uom": "EA",
                       "to_location": "PF-01-03-B", "from_location": None, "batch": None},
                      {"line": 2, "sku": "GLV-L", "qty": 40, "uom": "PR",
                       "to_location": "PF-01-02-A", "from_location": None, "batch": None}],
        })
        # One cycle count waiting, and one with a difference for a supervisor.
        self.post("/counts", {"warehouse": "BAL-WH01", "owner": "DEFAULT",
                              "locations": ["PF-01-06-A", "PF-01-10-B"], "priority": "normal"})
        self.post("/counts", {"warehouse": "BAL-WH01", "owner": "DEFAULT",
                              "locations": ["PF-01-05-C"], "priority": "normal"})
        tasks = self.get("/tasks", warehouse="BAL-WH01", type="count")["items"]
        task = tasks[-1]
        self.post(f"/tasks/{task['wms_id']}/start", {"operator": "op-019", "device": "SCN-BAL-08"})
        for i, line in enumerate(task["lines"]):
            # the first line comes up two short, so a supervisor has a variance to look at
            counted = Decimal(line["expected_qty"]) - (2 if i == 0 else 0)
            self.post(f"/tasks/{task['wms_id']}/lines/{line['line_no']}/confirm", {
                "qty": str(counted), "uom": line["uom"], "batch": line["batch"],
                "operator": "op-019", "device": "SCN-BAL-08",
            })

    def run(self) -> None:
        self.master_data()
        self.people()
        self.inbound()
        self.outbound()
        self.transfers()
        self.housekeeping()


def seed_demo(today: date | None = None) -> None:
    """Fill an empty database with a demo day. Refuses if the demo warehouses exist."""
    from wms.api.app import app

    with get_sessionmaker()() as db:
        taken = db.execute(
            select(Warehouse.code).where(Warehouse.code.in_([w[0] for w in WAREHOUSES]))
        ).scalars().all()
        if taken:
            raise SeedError(f"already here: {', '.join(taken)}. Demo data goes into an empty database.")
        client, key = access.create_api_client(
            db, name="demo-seed", scopes=["*"], warehouses=["*"], owner="*",
        )
        db.commit()
        client_id = client.id

    with TestClient(app) as c:
        seeder = Seeder(c, key, today or date.today())
        try:
            seeder.run()
        finally:
            seeder.post(f"/api-clients/{client_id}/revoke", {}, envelope=False)
