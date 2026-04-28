import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendWebhook, signPayload } from "../../src/push/webhook";

describe("signPayload", () => {
  it("produces consistent HMAC-SHA256 hex digest", async () => {
    const sig1 = await signPayload('{"test":true}', "secret123");
    const sig2 = await signPayload('{"test":true}', "secret123");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("different secrets produce different signatures", async () => {
    const sig1 = await signPayload("same body", "secret-a");
    const sig2 = await signPayload("same body", "secret-b");
    expect(sig1).not.toBe(sig2);
  });
});

describe("sendWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts JSON payload with HMAC signature header", async () => {
    await sendWebhook("https://example.com/hook", "my-secret", { event: "test" });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/hook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      body: JSON.stringify({ event: "test" }),
    });
  });

  it("does nothing when URL is empty", async () => {
    await sendWebhook("", "secret", { event: "test" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
