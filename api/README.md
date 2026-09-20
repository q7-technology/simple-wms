# Simple WMS API

FastAPI app, Alembic migrations, the queue worker and the `wms` command line.
The contract is in `../docs/api.md`.

## Layout

```
wms/config.py        settings from WMS_* environment variables
wms/db.py            engine and session factory
wms/models/          SQLAlchemy 2 models, one module per area
wms/services/        ledger (the only writer of stock_ledger), access, events
wms/api/             FastAPI app, auth, envelope handling, routes
wms/worker.py        drains outbound_event with backoff
wms/cli.py           create-api-client, create-user, rebuild-balances
alembic/             migrations
tests/               pytest, runs against a real Postgres
```

## Run locally

```
cd api
uv venv -p 3.12 && uv pip install -e ".[dev]"
docker compose -f ../docker-compose.yml up -d db
export WMS_DATABASE_URL=postgresql+psycopg://wms:wms-dev@127.0.0.1:5433/wms
.venv/bin/alembic upgrade head
.venv/bin/wms create-api-client --name dev
.venv/bin/uvicorn wms.api.app:app --reload
```

Then `curl -H "Authorization: Bearer <key>" localhost:8000/v1/products`.
Interactive docs at `/docs`.

## Tests

Tests use a real PostgreSQL so the append-only trigger is exercised for real.
They create and reset a `wms_test` database on the compose `db` service.

```
docker compose -f ../docker-compose.yml up -d db
.venv/bin/pytest
```

Point `TEST_DATABASE_URL` elsewhere if your database is not on 127.0.0.1:5433.

## Migrations

```
.venv/bin/alembic revision --autogenerate -m "what changed"
.venv/bin/alembic upgrade head
```

The `stock_ledger` and `audit_log` tables have a trigger that raises on
UPDATE or DELETE. Do not remove it. Correct a mistake with a new row.

`tests/test_migrations.py` runs every migration up, down and up again on a
database of its own, and checks the models and the migrations still agree.
A fresh install is covered by the test suite, not by hope.
