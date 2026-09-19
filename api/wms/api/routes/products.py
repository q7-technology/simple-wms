"""Products and their barcodes. Create or update by owner and sku."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from wms.api import envelope
from wms.api.deps import DB, Principal, authorise, require
from wms.api.errors import FieldError, NotFound
from wms.api.schemas import BarcodeOut, Page, ProductIn, ProductOut
from wms.models import Product, ProductBarcode

router = APIRouter(tags=["products"])


def product_out(p: Product) -> ProductOut:
    return ProductOut(
        wms_id=str(p.id), owner=p.owner, sku=p.sku, name=p.name, uom=p.uom,
        decimals_allowed=p.decimals_allowed, batch_tracked=p.batch_tracked,
        preferred_zone=p.preferred_zone, pickface_min=p.pickface_min,
        pickface_max=p.pickface_max, active=p.active,
        barcodes=[BarcodeOut(barcode=b.barcode, kind=b.kind, qty_per=b.qty_per)
                  for b in sorted(p.barcodes, key=lambda b: b.id)],
    )


@router.post("/products", status_code=202, response_model=envelope.Accepted)
def upsert_product(body: ProductIn, request: Request, db: DB,
                   who: Principal = require("master:write")):
    authorise(who, warehouse=None, owner=body.owner)

    def work():
        product = db.execute(
            select(Product)
            .options(selectinload(Product.barcodes))
            .where(Product.owner == body.owner, Product.sku == body.sku)
        ).scalar_one_or_none()
        data = body.model_dump(
            exclude_unset=True,
            exclude=set(envelope.Envelope.model_fields) | {"barcodes"},
        )
        if product is None:
            product = Product(owner=body.owner, **data)
            db.add(product)
            status = "created"
        else:
            for k, v in data.items():
                setattr(product, k, v)
            status = "updated"

        if "barcodes" in body.model_fields_set:
            wanted = {b.barcode: b for b in body.barcodes}
            for b in wanted.values():
                taken = db.execute(
                    select(ProductBarcode).where(ProductBarcode.barcode == b.barcode)
                ).scalar_one_or_none()
                if taken is not None and taken.product is not product:
                    raise FieldError("barcodes", f"{b.barcode} already belongs to {taken.product.sku}")
            product.barcodes = [
                existing for existing in product.barcodes if existing.barcode in wanted
            ]
            have = {b.barcode: b for b in product.barcodes}
            for code, b in wanted.items():
                if code in have:
                    have[code].kind = b.kind
                    have[code].qty_per = b.qty_per
                else:
                    product.barcodes.append(
                        ProductBarcode(barcode=code, kind=b.kind, qty_per=b.qty_per)
                    )
        db.flush()
        return envelope.Accepted(message_id=body.message_id, wms_id=str(product.id), status=status)

    return envelope.handle(db, who, body.message_id, request.url.path, work)


@router.get("/products", response_model=Page[ProductOut])
def list_products(
    db: DB, owner: str = "DEFAULT", q: str | None = None, active: bool | None = None,
    limit: int = Query(default=200, le=5000), offset: int = 0,
    who: Principal = require("master:read"),
):
    authorise(who, warehouse=None, owner=owner)
    query = select(Product).options(selectinload(Product.barcodes)).where(Product.owner == owner)
    if q:
        like = f"%{q}%"
        query = query.where(Product.sku.ilike(like) | Product.name.ilike(like))
    if active is not None:
        query = query.where(Product.active.is_(active))
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar_one()
    rows = db.execute(query.order_by(Product.sku).limit(limit).offset(offset)).scalars().all()
    return Page(items=[product_out(p) for p in rows], total=total)


@router.get("/products/{sku}", response_model=ProductOut)
def get_product(sku: str, db: DB, owner: str = "DEFAULT", who: Principal = require("master:read")):
    authorise(who, warehouse=None, owner=owner)
    product = db.execute(
        select(Product).options(selectinload(Product.barcodes))
        .where(Product.owner == owner, Product.sku == sku)
    ).scalar_one_or_none()
    if product is None:
        raise NotFound(f"no product {sku} for owner {owner}")
    return product_out(product)
