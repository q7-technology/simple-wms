"""Time-based one-time passwords, RFC 6238. Standard library only: an
authenticator app is a shared secret and a clock, not a dependency."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP = 30
DIGITS = 6
# how far either side of now a code is accepted, in steps. Phones drift.
DRIFT = 1
ISSUER = "Simple WMS"


def new_secret() -> str:
    """A base32 secret an authenticator app can read."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def code_at(secret: str, when: float | None = None, step: int = STEP, digits: int = DIGITS) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    counter = struct.pack(">Q", int((when if when is not None else time.time()) // step))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** digits)).zfill(digits)


def verify(secret: str, code: str, when: float | None = None) -> int | None:
    """Returns the step the code belongs to, or None. The step is returned so
    the caller can remember it and refuse the same code twice."""
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != DIGITS:
        return None
    now = when if when is not None else time.time()
    for drift in range(-DRIFT, DRIFT + 1):
        moment = now + drift * STEP
        if hmac.compare_digest(code_at(secret, moment), code):
            return int(moment // STEP)
    return None


def otpauth_url(secret: str, account: str, issuer: str = ISSUER) -> str:
    """What goes in the QR code."""
    label = f"{quote(issuer)}:{quote(account)}"
    return (f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP}")
