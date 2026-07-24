import { describe, it, expect } from "vitest";
// @ts-expect-error plain CJS module without types
import { detectQueryError, parseWranglerOutput } from "../../server-parse.cjs";

const BETA_WARNING =
  "▲ [WARNING] \u{1F6A7} `wrangler r2 sql query` is an open beta command. Please report any issues to https://github.com/cloudflare/workers-sdk/issues/new/choose";

const TABLE_OUTPUT = [
  " ⛅️ wrangler 4.111.0",
  "┌───────┬───────┐",
  "│ period │ value │",
  "│ 2026-07-01 │ 42 │",
  "└───────┴───────┘",
].join("\n");

const ERROR_OUTPUT = [
  " ⛅️ wrangler 4.111.0",
  BETA_WARNING,
  "",
  "✘ [ERROR] Query failed because of the following errors:",
  "",
  "  * 80011: Unauthenticated.",
  "",
  '\u{1FAB5}  Logs were written to "/root/.wrangler/logs/wrangler.log"',
].join("\n");

describe("detectQueryError", () => {
  it("returns the error text when wrangler reports a query failure", () => {
    const err = detectQueryError(ERROR_OUTPUT);
    expect(err).toContain("Query failed");
    expect(err).toContain("80011: Unauthenticated.");
    expect(err).not.toContain("Logs were written");
  });

  it("returns null for successful table output", () => {
    expect(detectQueryError(TABLE_OUTPUT)).toBeNull();
  });

  it("does not treat beta WARNING banners as errors", () => {
    expect(detectQueryError(`${BETA_WARNING}\n${TABLE_OUTPUT}`)).toBeNull();
  });

  it("detects errors wrapped in ANSI color codes (stderr without NO_COLOR)", () => {
    const ansi = "\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mQuery failed because of the following errors:\x1b[0m\n\n  * 42000: column not found\n";
    const err = detectQueryError(ansi);
    expect(err).toContain("42000: column not found");
  });
});

describe("parseWranglerOutput", () => {
  it("parses table rows into objects (regression)", () => {
    expect(parseWranglerOutput(TABLE_OUTPUT)).toEqual([{ period: "2026-07-01", value: 42 }]);
  });

  it("returns an empty array when no table is present", () => {
    expect(parseWranglerOutput(ERROR_OUTPUT)).toEqual([]);
  });
});
