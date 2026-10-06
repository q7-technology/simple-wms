import { RetryQueue } from "../lib/queue";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("RetryQueue", () => {
  it("sends straight away when online and keeps the reply", async () => {
    const send = vi.fn(async () => jsonResponse(202, { status: "accepted", task: { status: "in_progress" } }));
    const q = new RetryQueue({ send, storage: new Map(), online: () => true });
    const item = await q.submit({ path: "/v1/tasks/1/lines/1/confirm", body: { qty: 10 }, label: "Line 1 · ABC123 · 10 EA" });
    expect(item.status).toBe("sent");
    expect(item.reply).toEqual({ status: "accepted", task: { status: "in_progress" } });
    expect(q.pending().length).toBe(0);
    const sentBody = JSON.parse((send.mock.calls as unknown as [{ body: string }][])[0][0].body);
    expect(sentBody.message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("queues when offline and drains later with the same message_id", async () => {
    let online = false;
    const send = vi.fn(async () => jsonResponse(202, { status: "accepted" }));
    const storage = new Map<string, string>();
    const q = new RetryQueue({ send, storage, online: () => online });
    const item = await q.submit({ path: "/v1/x", body: { qty: 4 }, label: "Line 3 · short 4" });
    expect(item.status).toBe("queued");
    expect(q.pending().length).toBe(1);
    expect(send).not.toHaveBeenCalled();

    // a reload keeps the queue
    const q2 = new RetryQueue({ send, storage, online: () => online });
    expect(q2.pending()[0].label).toBe("Line 3 · short 4");

    online = true;
    const drained = await q2.drain();
    expect(drained).toBe(1);
    expect(q2.pending().length).toBe(0);
    const sentBody = JSON.parse((send.mock.calls as unknown as [{ body: string }][])[0][0].body);
    expect(sentBody.message_id).toBe(item.message_id);
  });

  it("keeps an item queued on a network failure but drops it on a 4xx the server will never accept", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(422, { errors: [{ field: "qty", message: "too many" }] }));
    const q = new RetryQueue({ send, storage: new Map(), online: () => true });
    const item = await q.submit({ path: "/v1/x", body: {}, label: "a" });
    expect(item.status).toBe("queued");
    expect(q.pending().length).toBe(1);
    await q.drain();
    expect(q.pending().length).toBe(0);
    expect(q.failed()[0].error).toBe("qty: too many");
  });
});
