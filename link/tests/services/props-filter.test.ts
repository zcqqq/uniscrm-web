import { describe, it, expect } from "vitest";
import { passesPropsFilter } from "../../../metadata/props-filter";
import type { PropFilter } from "../../../metadata/dataTypes";

describe("passesPropsFilter", () => {
  it("passes when filters is undefined or empty", () => {
    expect(passesPropsFilter(undefined, { duration: 999 })).toBe(true);
    expect(passesPropsFilter([], { duration: 999 })).toBe(true);
  });

  it("== uses strict equality on raw values (number 0 !== string '0')", () => {
    const f: PropFilter[] = [{ propId: "is_follow", operator: "==", value: 0 }];
    expect(passesPropsFilter(f, { is_follow: 0 })).toBe(true);
    expect(passesPropsFilter(f, { is_follow: "0" })).toBe(false);
    expect(passesPropsFilter(f, { is_follow: 1 })).toBe(false);
    expect(passesPropsFilter(f, {})).toBe(false);
  });

  it("!= uses strict inequality", () => {
    const f: PropFilter[] = [{ propId: "is_follow", operator: "!=", value: 1 }];
    expect(passesPropsFilter(f, { is_follow: 0 })).toBe(true);
    expect(passesPropsFilter(f, { is_follow: 1 })).toBe(false);
  });

  it("<= compares numerically, boundary inclusive", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<=", value: 120 }];
    expect(passesPropsFilter(f, { duration: 119 })).toBe(true);
    expect(passesPropsFilter(f, { duration: 120 })).toBe(true);
    expect(passesPropsFilter(f, { duration: 121 })).toBe(false);
  });

  it("ordering operators coerce numeric strings", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<", value: 120 }];
    expect(passesPropsFilter(f, { duration: "60" })).toBe(true);
    expect(passesPropsFilter(f, { duration: "180" })).toBe(false);
  });

  it("> and >= work", () => {
    expect(passesPropsFilter([{ propId: "n", operator: ">", value: 5 }], { n: 6 })).toBe(true);
    expect(passesPropsFilter([{ propId: "n", operator: ">", value: 5 }], { n: 5 })).toBe(false);
    expect(passesPropsFilter([{ propId: "n", operator: ">=", value: 5 }], { n: 5 })).toBe(true);
  });

  it("ordering operators fail closed on missing prop or non-numeric value", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<=", value: 120 }];
    expect(passesPropsFilter(f, {})).toBe(false);
    expect(passesPropsFilter(f, { duration: undefined })).toBe(false);
    expect(passesPropsFilter(f, { duration: "abc" })).toBe(false);
    expect(passesPropsFilter(f, { duration: null })).toBe(false);
    expect(passesPropsFilter(f, { duration: "" })).toBe(false);
  });

  it("multiple filters are AND", () => {
    const f: PropFilter[] = [
      { propId: "duration", operator: "<=", value: 120 },
      { propId: "content_type", operator: "==", value: "VIDEO" },
    ];
    expect(passesPropsFilter(f, { duration: 60, content_type: "VIDEO" })).toBe(true);
    expect(passesPropsFilter(f, { duration: 60, content_type: "IMAGE" })).toBe(false);
    expect(passesPropsFilter(f, { duration: 200, content_type: "VIDEO" })).toBe(false);
  });
});
