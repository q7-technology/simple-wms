import { ApiClient, ApiError } from "../api/client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ApiClient", () => {
  let calls: { url: string; init: RequestInit }[];
  let responses: Response[];
  let client: ApiClient;

  beforeEach(() => {
    calls = [];
    responses = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift() ?? jsonResponse(500, { detail: "no response queued" });
    };
    client = new ApiClient({ fetcher, storage: new Map() });
  });

  it("sends the bearer token and parses json", async () => {
    client.setSession({ token: "wms_s.abc", refresh_token: "wms_r.xyz", expires_in: 900 });
    responses.push(jsonResponse(200, { items: [] }));
    const body = await client.get<{ items: unknown[] }>("/v1/products");
    expect(body.items).toEqual([]);
    expect(calls[0].url).toBe("/v1/products");
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer wms_s.abc");
  });

  it("refreshes once on 401 and retries the call", async () => {
    client.setSession({ token: "old", refresh_token: "r1", expires_in: 900 });
    responses.push(jsonResponse(401, { detail: "session expired or invalid" }));
    responses.push(jsonResponse(200, { token: "new", refresh_token: "r2", expires_in: 900, user: {} }));
    responses.push(jsonResponse(200, { ok: true }));
    const body = await client.get<{ ok: boolean }>("/v1/auth/me");
    expect(body.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["/v1/auth/me", "/v1/auth/refresh", "/v1/auth/me"]);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ refresh_token: "r1" });
    expect(new Headers(calls[2].init.headers).get("Authorization")).toBe("Bearer new");
    expect(client.session?.refresh_token).toBe("r2");
  });

  it("clears the session and throws when the refresh fails too", async () => {
    const signedOut = vi.fn();
    client.onSignedOut = signedOut;
    client.setSession({ token: "old", refresh_token: "r1", expires_in: 900 });
    responses.push(jsonResponse(401, { detail: "expired" }));
    responses.push(jsonResponse(401, { detail: "expired" }));
    await expect(client.get("/v1/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(client.session).toBeNull();
    expect(signedOut).toHaveBeenCalled();
  });

  it("turns a 422 into field errors", async () => {
    client.setSession({ token: "t", refresh_token: "r", expires_in: 900 });
    responses.push(jsonResponse(422, { errors: [{ field: "sku", message: "required" }] }));
    try {
      await client.post("/v1/products", { name: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.fieldErrors.sku).toBe("required");
      expect(err.message).toBe("sku: required");
    }
  });

  it("keeps the refresh token in storage so a reload can resume", () => {
    const storage = new Map<string, string>();
    const c1 = new ApiClient({ fetcher: async () => jsonResponse(200, {}), storage });
    c1.setSession({ token: "t", refresh_token: "keep-me", expires_in: 900 });
    const c2 = new ApiClient({ fetcher: async () => jsonResponse(200, {}), storage });
    expect(c2.storedRefreshToken()).toBe("keep-me");
  });
});
