import { describe, it, expect } from "vitest";
import { compareRows } from "../../../shared/frontend/components/DataTable";

describe("compareRows", () => {
  it("sorts numerically for sortType 'number', even when the value arrives as a string", () => {
    // Guards against R2 SQL (or any untyped API response) returning an INT column
    // as a numeric string, which would otherwise silently fall back to lexicographic
    // order (where "10" sorts before "9").
    const rows = [{ id: "a", count: "9" }, { id: "b", count: "10" }, { id: "c", count: 2 }];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, "count", "number", "asc"));
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("sorts chronologically for sortType 'date'", () => {
    const rows = [
      { id: "a", at: "2026-03-01T00:00:00.000Z" },
      { id: "b", at: "2026-01-01T00:00:00.000Z" },
      { id: "c", at: "2026-02-01T00:00:00.000Z" },
    ];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, "at", "date", "asc"));
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("puts missing values last regardless of sort direction", () => {
    const rows = [{ id: "a", count: 5 }, { id: "b", count: null as unknown as number }, { id: "c", count: 1 }];
    const asc = [...rows].sort((a, b) => compareRows(a, b, "count", "number", "asc"));
    expect(asc.map((r) => r.id)).toEqual(["c", "a", "b"]);
    const desc = [...rows].sort((a, b) => compareRows(a, b, "count", "number", "desc"));
    expect(desc.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("falls back to plain string/number comparison when no sortType is given", () => {
    const rows = [{ id: "a", name: "Bob" }, { id: "b", name: "Alice" }];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, "name", undefined, "asc"));
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
