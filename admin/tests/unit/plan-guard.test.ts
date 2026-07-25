import { describe, it, expect, vi } from "vitest";
import { createModuleGuard } from "../../../shared/plan-guard";

function fakeContext() {
  return {
    json: vi.fn((body: unknown, status: number) => ({ body, status })),
  };
}

describe("createModuleGuard", () => {
  it("blocks with 403 when the resolved tier disallows the module", async () => {
    const guard = createModuleGuard("content.recommendations", async () => "basic");
    const c = fakeContext();
    const next = vi.fn();

    const result = await guard(c, next);

    expect(c.json).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    expect(result).toEqual({ body: { error: "forbidden" }, status: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the resolved tier allows the module", async () => {
    const guard = createModuleGuard("content.recommendations", async () => "pro");
    const c = fakeContext();
    const next = vi.fn();

    await guard(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(c.json).not.toHaveBeenCalled();
  });

  // null means "tier unknown" — no subscription row, an expired one, or a failed lookup.
  // It must fall back to the cheapest plan, not skip the gate: fail closed, never open.
  it("blocks when resolveTier returns null and the lowest tier disallows the module", async () => {
    const guard = createModuleGuard("content.recommendations", async () => null);
    const c = fakeContext();
    const next = vi.fn();

    await guard(c, next);

    expect(c.json).toHaveBeenCalledWith({ error: "forbidden" }, 403);
    expect(next).not.toHaveBeenCalled();
  });

  it("still calls next() when resolveTier returns null but the lowest tier allows the module", async () => {
    const guard = createModuleGuard("social.channels", async () => null);
    const c = fakeContext();
    const next = vi.fn();

    await guard(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(c.json).not.toHaveBeenCalled();
  });

  it("allows an unrestricted module (empty features/modules map) regardless of tier", async () => {
    const guard = createModuleGuard("social.channels", async () => "basic");
    const c = fakeContext();
    const next = vi.fn();

    await guard(c, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
