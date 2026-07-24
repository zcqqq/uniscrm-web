import { test } from "node:test";
import assert from "node:assert/strict";
import { findViolations, isExempted } from "./time-format-audit.mjs";

test("flags toLocaleDateString / toLocaleTimeString", () => {
  const src = 'const a = new Date(x).toLocaleDateString();\nconst b = d.toLocaleTimeString();';
  const v = findViolations(src, "link/frontend/components/Foo.tsx");
  assert.equal(v.length, 2);
  assert.equal(v[0].label, "toLocaleDateString");
  assert.equal(v[1].line, 2);
});

test("flags new Date().toLocaleString but not number toLocaleString", () => {
  const src = 'a = new Date(x).toLocaleString();\nb = count.toLocaleString();';
  const v = findViolations(src, "flow/frontend/pages/Foo.tsx");
  assert.equal(v.length, 1);
  assert.equal(v[0].label, "new Date().toLocaleString");
});

test("flags bare Intl.DateTimeFormat but allows resolvedOptions timezone detection", () => {
  const src =
    'const f = new Intl.DateTimeFormat("en", { timeStyle: "medium" });\n' +
    "const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;";
  const v = findViolations(src, "web/src/pages/Foo.tsx");
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

test("shared format-time.ts itself is allowed", () => {
  const src = 'new Intl.DateTimeFormat("en-US", { timeZone: timezone });';
  assert.equal(findViolations(src, "shared/frontend/lib/format-time.ts").length, 0);
});

test("time-format-ok exemption on same or previous line", () => {
  const src =
    "// time-format-ok: chart axis\n" +
    "const a = d.toLocaleDateString();\n" +
    "const b = d.toLocaleDateString(); // time-format-ok: legit\n" +
    "const unrelated = 1;\n" +
    "const c = d.toLocaleDateString();";
  assert.ok(isExempted(src, 2));
  assert.ok(isExempted(src, 3));
  assert.ok(!isExempted(src, 5));
});
