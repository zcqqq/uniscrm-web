import { describe, it, expect } from "vitest";
import { maskEmail, describeTenant } from "../../src/services/tenant-label";

function webDb(row: { email: string | null } | null, throws = false) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (throws) throw new Error("D1 unavailable");
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
}

describe("maskEmail", () => {
  it("keeps the first character and the domain, hides the rest of the local part", () => {
    expect(maskEmail("zhengchao@gmail.com")).toBe("z********@gmail.com");
  });

  it("still masks a one-character local part instead of exposing it bare", () => {
    expect(maskEmail("a@b.com")).toBe("a*@b.com");
  });

  it("returns null for anything that is not an address", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("no-at-sign")).toBeNull();
    expect(maskEmail("@leading")).toBeNull();
    expect(maskEmail("trailing@")).toBeNull();
  });
});

describe("describeTenant", () => {
  it("names the tenant by id and masked owner email", async () => {
    expect(await describeTenant(webDb({ email: "owner@example.com" }), 42)).toBe("#42, o****@example.com");
  });

  it("falls back to the bare id when the tenant has no email on record", async () => {
    expect(await describeTenant(webDb({ email: null }), 42)).toBe("#42");
  });

  // This runs inside a 409 handler; a lookup failure must not turn it into a 500.
  it("degrades to the bare id when the lookup throws", async () => {
    expect(await describeTenant(webDb(null, true), 42)).toBe("#42");
  });

  it("degrades to the bare id when WEB_DB is not bound", async () => {
    expect(await describeTenant(undefined, 42)).toBe("#42");
  });

  it("says unassigned rather than #null for a tenant-less channel", async () => {
    expect(await describeTenant(webDb(null), null)).toBe("unassigned");
  });
});
