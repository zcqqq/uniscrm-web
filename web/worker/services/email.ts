const FROM_ADDRESS = "UniSCRM <noreply@uni-scrm.com>";

// Minimal interface for the Cloudflare Email Service send_email binding
// (object-form send; installed @cloudflare/workers-types predates it).
export interface EmailSender {
  send(message: { from: string; to: string; subject: string; html: string }): Promise<unknown>;
}

export class EmailService {
  constructor(
    private email: EmailSender,
    private appUrl: string
  ) {}

  async sendVerificationCode(email: string, code: string): Promise<void> {
    await this.email.send({
      from: FROM_ADDRESS,
      to: email,
      subject: "Your verification code",
      html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 10 minutes.</p>`,
    });
  }

  async sendMagicLink(email: string, token: string): Promise<void> {
    const link = `${this.appUrl}/auth/verify?token=${token}`;
    await this.email.send({
      from: FROM_ADDRESS,
      to: email,
      subject: "Sign in to UniSCRM",
      html: `<p>Click <a href="${link}">here</a> to sign in. This link expires in 15 minutes.</p>`,
    });
  }
}
