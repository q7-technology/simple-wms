"""A fresh install must work, and so must going back. Runs every migration
up, down and up again on a database of its own."""
import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from conftest import TEST_DATABASE_URL

MIGRATION_URL = TEST_DATABASE_URL.rsplit("/", 1)[0] + "/wms_migration_check"


@pytest.fixture
def blank_database(monkeypatch):
    admin = TEST_DATABASE_URL.rsplit("/", 1)[0] + "/postgres"
    name = MIGRATION_URL.rsplit("/", 1)[1]
    engine = create_engine(admin, isolation_level="AUTOCOMMIT")
    with engine.connect() as conn:
        conn.execute(text(f'drop database if exists "{name}" with (force)'))
        conn.execute(text(f'create database "{name}"'))
    engine.dispose()
    # alembic/env.py prefers this over the ini, so point it at the blank one
    monkeypatch.setenv("WMS_DATABASE_URL", MIGRATION_URL)
    yield MIGRATION_URL
    engine = create_engine(admin, isolation_level="AUTOCOMMIT")
    with engine.connect() as conn:
        conn.execute(text(f'drop database if exists "{name}" with (force)'))
    engine.dispose()


def alembic_config(url: str) -> Config:
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False
    return cfg


def test_every_migration_goes_up_down_and_up_again(blank_database):
    cfg = alembic_config(blank_database)
    engine = create_engine(blank_database)

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        tables = conn.execute(text(
            "select table_name from information_schema.tables where table_schema='public'"
        )).scalars().all()
    assert "stock_ledger" in tables and "print_point" in tables
    assert len(tables) > 20

    # the append-only trigger is there on a fresh install, not just in tests
    with engine.connect() as conn:
        triggers = conn.execute(text(
            "select tgname from pg_trigger where not tgisinternal order by tgname"
        )).scalars().all()
    assert "stock_ledger_append_only" in triggers
    assert "audit_log_append_only" in triggers

    command.downgrade(cfg, "base")
    with engine.connect() as conn:
        left = conn.execute(text(
            "select table_name from information_schema.tables where table_schema='public'"
        )).scalars().all()
    assert left == ["alembic_version"]

    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        again = conn.execute(text(
            "select table_name from information_schema.tables where table_schema='public'"
        )).scalars().all()
    assert sorted(again) == sorted(tables)
    engine.dispose()


def test_the_models_match_the_migrations(blank_database):
    """No drift: what the models say is what a fresh database gets."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from wms.models import Base

    cfg = alembic_config(blank_database)
    command.upgrade(cfg, "head")
    engine = create_engine(blank_database)
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    engine.dispose()
    assert diff == [], f"the models and the migrations disagree: {diff}"
