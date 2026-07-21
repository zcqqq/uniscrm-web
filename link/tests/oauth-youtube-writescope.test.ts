import { describe, it, expect, vi } from "vitest";

const createAuthorizationURLMock = vi.fn().mockReturnValue(new URL("https://accounts.google.com/o/oauth2/v2/auth"));

vi.mock("arctic", () => ({
  Google: class {
    createAuthorizationURL(...args: unknown[]) { return createAuthorizationURLMock(...args); }
  },
  generateState: () => "state",
  generateCodeVerifier: () => "verifier",
  decodeIdToken: () => ({ sub: "google-user", email: "u@example.com" }),
}));

describe("YouTube OAuth authorization URL", () => {
  it("requests youtube.force-ssl scope, offline access, and consent prompt", async () => {
    const { buildYouTubeAuthUrl } = await import("../src/oauth");
    const { url } = buildYouTubeAuthUrl("client", "secret", "https://app.test/api/auth/youtube/callback");
    const scopes = createAuthorizationURLMock.mock.calls[0][2] as string[];
    expect(scopes).toContain("https://www.googleapis.com/auth/youtube.force-ssl");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
  });
});
