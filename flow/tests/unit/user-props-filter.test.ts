import { describe, it, expect, vi } from "vitest";
import { resolveUserPropsForFilter } from "../../src/index";

describe("resolveUserPropsForFilter", () => {
  it("reads is_follow from entity_state, not from a tenant D1", async () => {
    const first = vi.fn().mockResolvedValue({ is_follow: 1, is_followed: 0 });
    const env = {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first }) }) },
    };

    const props = await resolveUserPropsForFilter(env as any, 7, "u1");

    expect(props).toEqual({ is_follow: 1, is_followed: 0 });
  });

  it("returns an empty object when the user is unknown, so a fail-closed filter blocks the action", async () => {
    const env = {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) },
    };

    expect(await resolveUserPropsForFilter(env as any, 7, "nope")).toEqual({});
  });
});
