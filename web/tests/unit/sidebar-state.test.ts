import { describe, it, expect } from "vitest";
import { groupCookieString, parseGroupCookie } from "../../../shared/frontend/sidebar-state";

describe("parseGroupCookie", () => {
  it("reads the expanded groups back in order", () => {
    expect(parseGroupCookie("sidebar-groups=social,content")).toEqual(["social", "content"]);
  });

  it("finds the cookie whatever position it sits in", () => {
    expect(parseGroupCookie("theme=dark; sidebar-groups=insight; sidebar=expanded")).toEqual(["insight"]);
  });

  // "sidebar" is a separate cookie holding the collapsed/expanded width. Matching it here would
  // parse "expanded" as a group id.
  it("does not confuse itself with the sidebar width cookie", () => {
    expect(parseGroupCookie("sidebar=collapsed")).toBeNull();
  });

  it("returns null when nothing is stored so the caller can apply its default", () => {
    expect(parseGroupCookie("")).toBeNull();
    expect(parseGroupCookie("theme=dark")).toBeNull();
  });

  // Collapsing every group has to survive a reload. Without a sentinel this would read back as
  // "nothing stored" and the default group would spring open again.
  it("round-trips an empty selection", () => {
    expect(parseGroupCookie(groupCookieString([]).split(";")[0])).toEqual([]);
  });

  it("round-trips a populated selection", () => {
    const groups = ["social", "profile", "settings"];
    expect(parseGroupCookie(groupCookieString(groups).split(";")[0])).toEqual(groups);
  });
});

describe("groupCookieString", () => {
  // The whole point of the fix: every module Worker sits on its own origin, so the state only
  // stays consistent if the cookie is scoped to the shared parent domain.
  it("scopes the cookie to the parent domain so all modules share one state", () => {
    const cookie = groupCookieString(["social"]);
    expect(cookie).toContain("domain=uni-scrm.com");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("secure");
    expect(cookie).toContain("samesite=lax");
  });

  it("persists for a year", () => {
    expect(groupCookieString(["social"])).toContain("max-age=31536000");
  });
});
