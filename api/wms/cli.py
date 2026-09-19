"""Command line for the things that have to happen before there is an API key."""
from __future__ import annotations

import argparse
import getpass
import sys

from wms.db import get_sessionmaker
from wms.models import User
from wms.services import access
from wms.services.ledger import rebuild_balances


def cmd_create_api_client(args) -> int:
    with get_sessionmaker()() as db:
        client, raw = access.create_api_client(
            db, name=args.name, scopes=args.scopes.split(","),
            warehouses=args.warehouses.split(","), owner=args.owner,
        )
        db.commit()
        print(f"api client {client.name} (id {client.id}) created")
        print("This key is shown once and never stored:")
        print(raw)
    return 0


def cmd_create_user(args) -> int:
    password = args.password or getpass.getpass("Password: ")
    with get_sessionmaker()() as db:
        user = User(
            username=args.username, display_name=args.display_name or args.username,
            email=args.email, role=args.role, warehouses=args.warehouses.split(","),
            password_hash=access.hash_password(password),
        )
        db.add(user)
        db.commit()
        print(f"user {user.username} (id {user.id}) created with role {user.role}")
    return 0


def cmd_rebuild_balances(args) -> int:
    with get_sessionmaker()() as db:
        n = rebuild_balances(db)
        db.commit()
        print(f"stock_balance rebuilt from the ledger: {n} rows")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wms")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create-api-client", help="create a scoped API key (printed once)")
    p.add_argument("--name", required=True)
    p.add_argument("--scopes", default="*", help="comma separated, e.g. master:write,stock:read or *")
    p.add_argument("--warehouses", default="*", help="comma separated codes or *")
    p.add_argument("--owner", default="DEFAULT")
    p.set_defaults(func=cmd_create_api_client)

    p = sub.add_parser("create-user", help="create a desktop user")
    p.add_argument("--username", required=True)
    p.add_argument("--display-name")
    p.add_argument("--email")
    p.add_argument("--role", default="admin",
                   choices=["picker", "receiver", "supervisor", "inventory_controller", "admin"])
    p.add_argument("--warehouses", default="*")
    p.add_argument("--password", help="prompted for if omitted")
    p.set_defaults(func=cmd_create_user)

    p = sub.add_parser("rebuild-balances", help="recompute stock_balance from the ledger")
    p.set_defaults(func=cmd_rebuild_balances)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
