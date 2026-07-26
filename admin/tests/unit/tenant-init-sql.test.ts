import { describe, it, expect } from "vitest";
import { TENANT_DB_INIT_SQL } from "../../src/services/tenant-init-sql";

const all = TENANT_DB_INIT_SQL.join("\n");

describe("TENANT_DB_INIT_SQL", () => {
  it("creates exactly the user and content tables — the deleted features stay deleted", () => {
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["content", "user"]);
    // deleted-feature TABLES must not return; word-boundary regexes so that the
    // profile_image_url COLUMN (a real user field) cannot false-positive.
    for (const gone of [/\bprofile\b(?!_image_url)/, /\bsegment_profiles\b/, /\bevent\b/, /\bcontent_trigger_dedup\b/]) {
      expect(all).not.toMatch(gone);
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

  it("user keeps the display columns the R2 copy projects (avatar/description/verified_type)", () => {
    for (const col of ["profile_image_url", "description", "verified_type"]) {
      expect(all).toContain(col);
    }
  });
});
