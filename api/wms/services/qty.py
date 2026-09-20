from decimal import Decimal


def qstr(d: Decimal | None) -> str | None:
    """Decimal to a plain string with no trailing zeros, for events and replies."""
    if d is None:
        return None
    return format(d.normalize(), "f") if d else "0"
