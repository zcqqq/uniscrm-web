import { describe, it, expect } from "vitest";
// Imports from the pure ./datetimeGranularity module rather than
// DatetimeDimensionPopover.tsx directly: the component file transitively
// imports Radix's Popover -> react-remove-scroll, whose legacy subpath
// package.json (react-remove-scroll-bar/constants) the
// @cloudflare/vitest-pool-workers runtime cannot resolve (known issue:
// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution).
// DatetimeDimensionPopover.tsx re-exports suggestGranularity/DatetimeGranularity
// from this module, so the public import path from the brief still works at
// build time for real consumers (e.g. Task 5) — only this unit test needs to
// reach past it to stay dependency-free.
import { suggestGranularity } from "../../../shared/frontend/components/datetimeGranularity";

describe("suggestGranularity", () => {
  it("suggests 'none' when min or max is missing", () => {
    expect(suggestGranularity(null, null)).toBe("none");
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", null)).toBe("none");
  });

  it("suggests 'none' for a single data point (min === max)", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("none");
  });

  it("suggests 'hour' for a span under 2 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z")).toBe("hour");
  });

  it("suggests 'day' for a span under 60 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-02-15T00:00:00.000Z")).toBe("day");
  });

  it("suggests 'week' for a span under 365 days", () => {
    expect(suggestGranularity("2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z")).toBe("week");
  });

  it("suggests 'month' for a span under 2 years", () => {
    expect(suggestGranularity("2024-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z")).toBe("month");
  });

  it("suggests 'quarter' for a span over 2 years", () => {
    expect(suggestGranularity("2020-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("quarter");
  });
});
