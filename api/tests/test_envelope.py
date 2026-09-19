import uuid


def product_body(**extra):
    return {
        "message_id": str(uuid.uuid4()),
        "owner": "DEFAULT",
        "sku": "ABC123",
        "name": "Widget",
        "uom": "EA",
        **extra,
    }


def test_repeated_message_id_returns_the_original_reply_and_does_nothing(client, headers):
    body = product_body()
    r1 = client.post("/v1/products", json=body, headers=headers)
    assert r1.status_code == 202, r1.text
    assert r1.json()["message_id"] == body["message_id"]
    assert r1.json()["status"] == "created"

    r2 = client.post("/v1/products", json={**body, "name": "Changed"}, headers=headers)
    assert r2.status_code == 202
    assert r2.json() == r1.json()

    got = client.get("/v1/products/ABC123", headers=headers)
    assert got.json()["name"] == "Widget"


def test_missing_message_id_is_a_422_with_field_errors(client, headers):
    body = product_body()
    del body["message_id"]
    r = client.post("/v1/products", json=body, headers=headers)
    assert r.status_code == 422
    assert any(e["field"] == "message_id" for e in r.json()["errors"])


def test_requests_without_a_key_are_rejected(client):
    assert client.get("/v1/products").status_code == 401
    assert client.get("/v1/products", headers={"Authorization": "Bearer nope"}).status_code == 401
