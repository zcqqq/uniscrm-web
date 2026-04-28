import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailService } from "../../worker/services/email";

describe("EmailService", () => {
  let fetchSpy: any;
  let service: EmailService;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{"id":"msg-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    service = new EmailService("re_test_key", "https://app.example.com");
  });

  it("sends magic link email via Resend API", async () => {
    await service.sendMagicLink("user@example.com", "token123");

    expect(fetchSpy).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer re_test_key",
      },
      body: expect.stringContaining("token123"),
    });
  });

  it("includes correct link in email body", async () => {
    await service.sendMagicLink("user@example.com", "abc-token");

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.html).toContain("https://app.example.com/auth/verify?token=abc-token");
  });

  it("throws on non-ok response", async () => {
    fetchSpy.mockResolvedValue(new Response("error", { status: 500 }));

    await expect(service.sendMagicLink("user@example.com", "tok")).rejects.toThrow(
      "Resend API error: 500"
    );
  });
});
