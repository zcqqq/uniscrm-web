export class EmailService {
  constructor(
    private apiKey: string,
    private appUrl: string
  ) {}

  async sendVerificationCode(email: string, code: string): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: "UniSCRM <onboarding@resend.dev>",
        to: [email],
        subject: "Your verification code",
        html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 10 minutes.</p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend API error: ${response.status} ${body}`);
    }
  }

  async sendMagicLink(email: string, token: string): Promise<void> {
    const link = `${this.appUrl}/auth/verify?token=${token}`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: "UniSCRM <onboarding@resend.dev>",
        to: [email],
        subject: "Sign in to UniSCRM",
        html: `<p>Click <a href="${link}">here</a> to sign in. This link expires in 15 minutes.</p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend API error: ${response.status} ${body}`);
    }
  }
}
