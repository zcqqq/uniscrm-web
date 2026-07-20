import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailService } from "../../worker/services/email";

describe("EmailService", () => {
  let sendSpy: any;
  let service: EmailService;

  beforeEach(() => {
    sendSpy = vi.fn().mockResolvedValue({ messageId: "msg-1" });
    service = new EmailService({ send: sendSpy }, "https://app.example.com");
  });

  it("sends magic link email via EMAIL_WEB binding", async () => {
    await service.sendMagicLink("user@example.com", "token123");

    expect(sendSpy).toHaveBeenCalledWith({
      from: "UniSCRM <noreply@uni-scrm.com>",
      to: "user@example.com",
      subject: "Sign in to UniSCRM",
      html: expect.stringContaining("token123"),
    });
  });

  it("includes correct link in email body", async () => {
    await service.sendMagicLink("user@example.com", "abc-token");

    const message = sendSpy.mock.calls[0][0];
    expect(message.html).toContain("https://app.example.com/auth/verify?token=abc-token");
  });

  it("sends verification code email via EMAIL_WEB binding", async () => {
    await service.sendVerificationCode("user@example.com", "123456");

    expect(sendSpy).toHaveBeenCalledWith({
      from: "UniSCRM <noreply@uni-scrm.com>",
      to: "user@example.com",
      subject: "Your verification code",
      html: expect.stringContaining("123456"),
    });
  });

  it("propagates binding send failure", async () => {
    sendSpy.mockRejectedValue(new Error("daily sending limit exceeded"));

    await expect(service.sendMagicLink("user@example.com", "tok")).rejects.toThrow(
      "daily sending limit exceeded"
    );
  });
});
