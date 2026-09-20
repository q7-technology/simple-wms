from fastapi import APIRouter, FastAPI
from sqlalchemy import text

from wms.api import errors
from wms.api.deps import DB
from wms.api.routes import (
    access, auth, imports, inbound, integration, outbound, products, scans, stock, structure, tasks,
)
import wms.services.inbound  # noqa: F401  registers task hooks
import wms.services.outbound  # noqa: F401  registers task hooks

app = FastAPI(
    title="Simple WMS",
    version="0.1.0",
    description="Open source, self-hosted warehouse management. The API is the only door.",
    docs_url="/docs",
    redoc_url=None,
)
errors.install(app)

v1 = APIRouter(prefix="/v1")
v1.include_router(auth.router)
v1.include_router(structure.router)
v1.include_router(products.router)
v1.include_router(stock.router)
v1.include_router(tasks.router)
v1.include_router(inbound.router)
v1.include_router(outbound.router)
v1.include_router(scans.router)
v1.include_router(imports.router)
v1.include_router(integration.router)
v1.include_router(access.router)


@v1.get("/health", tags=["system"])
def health(db: DB):
    db.execute(text("select 1"))
    return {"status": "ok"}


app.include_router(v1)
