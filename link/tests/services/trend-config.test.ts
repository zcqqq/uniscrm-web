import { describe, it, expect } from "vitest";
import { getTwitterConfig, getTikTokConfig, getDouyinConfig } from "../../src/trend/config";

// handleTrendAggregation builds its source list straight off trend.json, and the X source runs
// hourly on the app-only bearer token — independent of any channel, so pausing every X channel
// does not stop it. While the account that owns the app is frozen, the TWITTER entry stays out
// of trend.json; this pins that, and pins that removing it left the other sources alone.
describe("trend.json source configuration", () => {
  it("has no TWITTER source while the X account is frozen", () => {
    expect(getTwitterConfig()).toBeNull();
  });

  it("still configures the non-X sources", () => {
    expect(getTikTokConfig()?.locations.length).toBeGreaterThan(0);
    expect(getDouyinConfig()?.categories.length).toBeGreaterThan(0);
  });
});
