"""The sign-in screen promises a second factor for admins. This is it."""
import base64
import hashlib
import hmac
import struct
import time

from sqlalchemy import select

from wms.models import AuditLog, User


def totp(secret: str, when: int | None = None, step: int = 30, digits: int = 6) -> str:
    """RFC 6238, worked by hand so the test does not trust the code it tests."""
    key = base64.b32decode(secret, casefold=True)
    counter = struct.pack(">Q", int((when or time.time()) // step))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def login(client, username="leighton", password="correct horse"):
    return client.post("/v1/auth/login", json={"username": username, "password": password})


def enable_2fa(client, headers):
    r = client.post("/v1/auth/2fa/setup", headers=headers)
    assert r.status_code == 200, r.text
    secret = r.json()["secret"]
    r = client.post("/v1/auth/2fa/enable", headers=headers, json={"code": totp(secret)})
    assert r.status_code == 200, r.text
    return secret


# --- turning it on ------------------------------------------------------------

def test_setup_hands_back_a_secret_and_something_to_scan(client, db, admin, user_headers):
    r = client.post("/v1/auth/2fa/setup", headers=user_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["secret"]) == 32
    assert body["otpauth_url"].startswith("otpauth://totp/Simple%20WMS:leighton?")
    assert f"secret={body['secret']}" in body["otpauth_url"]
    assert "issuer=Simple%20WMS" in body["otpauth_url"]
    # nothing is on until a code proves the phone has it
    assert client.get("/v1/auth/me", headers=user_headers).json()["two_factor"] is False


def test_a_wrong_code_does_not_switch_it_on(client, db, admin, user_headers):
    client.post("/v1/auth/2fa/setup", headers=user_headers)
    r = client.post("/v1/auth/2fa/enable", headers=user_headers, json={"code": "000000"})
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "code"
    assert client.get("/v1/auth/me", headers=user_headers).json()["two_factor"] is False


def test_enabling_it_needs_a_setup_first(client, db, admin, user_headers):
    r = client.post("/v1/auth/2fa/enable", headers=user_headers, json={"code": "123456"})
    assert r.status_code == 409
    assert r.json()["code"] == "no_setup"


# --- signing in with it -------------------------------------------------------

def test_sign_in_asks_for_the_second_factor(client, db, admin, user_headers):
    secret = enable_2fa(client, user_headers)
    assert client.get("/v1/auth/me", headers=user_headers).json()["two_factor"] is True

    r = login(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "totp_required"
    assert body["challenge"]
    assert "token" not in body and "refresh_token" not in body

    r = client.post("/v1/auth/login/totp", json={"challenge": body["challenge"], "code": totp(secret)})
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["token"].startswith("wms_s.")
    assert done["user"]["username"] == "leighton"
    h = {"Authorization": f"Bearer {done['token']}"}
    assert client.get("/v1/auth/me", headers=h).json()["username"] == "leighton"


def test_a_wrong_second_factor_is_refused_and_audited(client, db, admin, user_headers):
    enable_2fa(client, user_headers)
    challenge = login(client).json()["challenge"]
    r = client.post("/v1/auth/login/totp", json={"challenge": challenge, "code": "000000"})
    assert r.status_code == 401
    assert r.json()["code"] == "wrong_code"
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "login_2fa_failed" in actions


def test_a_challenge_is_good_once_and_not_for_long(client, db, admin, user_headers):
    secret = enable_2fa(client, user_headers)
    challenge = login(client).json()["challenge"]
    assert client.post("/v1/auth/login/totp",
                       json={"challenge": challenge, "code": totp(secret)}).status_code == 200
    r = client.post("/v1/auth/login/totp", json={"challenge": challenge, "code": totp(secret)})
    assert r.status_code == 401
    assert r.json()["code"] == "unknown_challenge"


def test_the_code_from_the_step_before_still_works(client, db, admin, user_headers):
    """Phones drift. One step either side is accepted, no more."""
    secret = enable_2fa(client, user_headers)
    challenge = login(client).json()["challenge"]
    just_before = totp(secret, when=time.time() - 30)
    r = client.post("/v1/auth/login/totp", json={"challenge": challenge, "code": just_before})
    assert r.status_code == 200, r.text

    challenge = login(client).json()["challenge"]
    long_ago = totp(secret, when=time.time() - 300)
    assert client.post("/v1/auth/login/totp",
                       json={"challenge": challenge, "code": long_ago}).status_code == 401


def test_a_code_cannot_be_used_twice(client, db, admin, user_headers):
    secret = enable_2fa(client, user_headers)
    code = totp(secret)
    challenge = login(client).json()["challenge"]
    assert client.post("/v1/auth/login/totp",
                       json={"challenge": challenge, "code": code}).status_code == 200
    challenge = login(client).json()["challenge"]
    r = client.post("/v1/auth/login/totp", json={"challenge": challenge, "code": code})
    assert r.status_code == 401
    assert r.json()["code"] == "code_used"


# --- turning it off -----------------------------------------------------------

def test_turning_it_off_needs_the_password(client, db, admin, user_headers):
    enable_2fa(client, user_headers)
    r = client.post("/v1/auth/2fa/disable", headers=user_headers, json={"password": "wrong"})
    assert r.status_code == 401
    r = client.post("/v1/auth/2fa/disable", headers=user_headers, json={"password": "correct horse"})
    assert r.status_code == 200, r.text
    assert client.get("/v1/auth/me", headers=user_headers).json()["two_factor"] is False
    assert login(client).json()["status"] == "signed_in"


def test_an_admin_can_clear_it_for_someone_who_lost_their_phone(client, db, admin, user_headers, picker):
    from conftest import login as sign_in

    picker_headers = {"Authorization": f"Bearer {sign_in(client, 'sam', 'pick pick')['token']}"}
    enable_2fa(client, picker_headers)
    r = client.post(f"/v1/users/{picker.id}/clear-2fa", headers=user_headers, json={})
    assert r.status_code == 200, r.text
    assert r.json()["two_factor"] is False
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "user.2fa_cleared" in actions


# --- too many tries -----------------------------------------------------------

def test_a_run_of_wrong_passwords_locks_the_account(client, db, admin):
    for i in range(4):
        r = client.post("/v1/auth/login", json={"username": "leighton", "password": "nope"})
        assert r.status_code == 401
        assert r.json()["code"] == "wrong_password"
        assert r.json()["tries_left"] == 4 - i
    r = client.post("/v1/auth/login", json={"username": "leighton", "password": "nope"})
    assert r.status_code == 401
    assert r.json()["code"] == "locked"
    # the right password does not help while it is locked
    r = login(client)
    assert r.status_code == 401 and r.json()["code"] == "locked"

    row = db.execute(select(User).where(User.username == "leighton")).scalar_one()
    assert row.failed_attempts >= 5
    assert row.locked_until is not None
    actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "user.locked" in actions


def test_a_good_sign_in_clears_the_count(client, db, admin):
    client.post("/v1/auth/login", json={"username": "leighton", "password": "nope"})
    client.post("/v1/auth/login", json={"username": "leighton", "password": "nope"})
    assert login(client).status_code == 200
    row = db.execute(select(User).where(User.username == "leighton")).scalar_one()
    assert row.failed_attempts == 0


def test_an_admin_can_unlock_someone(client, db, admin, user_headers, picker):
    for _ in range(5):
        client.post("/v1/auth/login", json={"username": "sam", "password": "nope"})
    assert client.post("/v1/auth/login",
                       json={"username": "sam", "password": "pick pick"}).json()["code"] == "locked"
    r = client.post(f"/v1/users/{picker.id}/unlock", headers=user_headers, json={})
    assert r.status_code == 200, r.text
    assert client.post("/v1/auth/login",
                       json={"username": "sam", "password": "pick pick"}).status_code == 200


def test_an_unknown_username_gives_nothing_away(client, db, admin):
    r = client.post("/v1/auth/login", json={"username": "nobody", "password": "nope"})
    assert r.status_code == 401
    assert r.json()["code"] == "wrong_password"
    assert "tries_left" not in r.json()
