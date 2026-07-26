import { describe, it, expect } from "vitest";
import { TENANT_DB_INIT_SQL } from "../../src/services/tenant-init-sql";

const all = TENANT_DB_INIT_SQL.join("\n");

describe("TENANT_DB_INIT_SQL", () => {
  it("creates exactly the user and content tables — the deleted features stay deleted", () => {
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["content", "user"]);
    for (const gone of ["profile", "segment_profiles", "event", "content_trigger_dedup"]) {
      expect(all).not.toContain(gone);
    }
  });

  it("user has no profile_id and uses post_count (the 0005 rename is baked in)", () => {
    expect(all).not.toContain("profile_id");
    expect(all).not.toContain("tweet_count");
    expect(all).toContain("post_count");
  });

  it("content has no status column and no status index", () => {
    expect(all).not.toMatch(/\bstatus\b/);
  });

  it("keeps the dedup unique indexes both writers rely on", () => {
    expect(all).toContain("idx_user_channel_source");
    expect(all).toContain("idx_content_channel_source");
    expect(all).toContain("idx_content_channel_list_source");
  });
});
