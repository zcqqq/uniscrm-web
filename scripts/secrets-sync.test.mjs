// Guards the wiring between module `.secrets.json` files and the deploy workflows'
// `sync-secrets` job. A module can declare secrets it needs and still never receive them:
// analytics declared none and was absent from both matrices, so its R2_CATALOG_TOKEN was
// hand-set with `wrangler secret put` and nothing propagated a rotation — the worker sat
// on a dead token, R2 SQL returned `80011: Unauthenticated`, and the nightly compactor
// failed silently (CF Container stdout is not queryable). Two independent gaps cause that
// class of failure, so both are checked here:
//   1. a module with a .secrets.json is missing from a workflow's sync-secrets matrix
//   2. a secret name is listed in a .secrets.json but not exported in the job's `env:`
//      block, which makes sync-secrets.sh exit 1 with "Missing GitHub secrets"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The env key in .secrets.json ("dev"/"production") is also the first argument
// sync-secrets.sh receives, so each workflow reads exactly one of the two lists.
const WORKFLOWS = [
  { file: ".github/workflows/deploy-dev.yml", env: "dev" },
  { file: ".github/workflows/deploy-prod.yml", env: "production" },
];

/** Slice the sync-secrets job out of a workflow: from its key to the next top-level job. */
function syncSecretsJob(yaml) {
  const start = yaml.indexOf("\n  sync-secrets:");
  assert.notEqual(start, -1, "workflow has no sync-secrets job");
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function modulesWithSecrets() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, ".secrets.json")))
    .map((d) => ({
      module: d.name,
      required: JSON.parse(readFileSync(join(ROOT, d.name, ".secrets.json"), "utf-8")),
    }));
}

for (const { file, env } of WORKFLOWS) {
  const job = syncSecretsJob(readFileSync(join(ROOT, file), "utf-8"));
  const matrix = [...job.matchAll(/^\s+- module: (\S+)\s*\n\s+config: (\S+)/gm)].map((m) => ({
    module: m[1],
    config: m[2],
  }));
  const exported = new Set(
    [...job.matchAll(/^\s+([A-Z0-9_]+): \$\{\{ secrets\./gm)].map((m) => m[1])
  );

  test(`${file}: every module with a .secrets.json is in the sync-secrets matrix`, () => {
    for (const { module } of modulesWithSecrets()) {
      const entry = matrix.find((m) => m.module === module);
      assert.ok(entry, `${module} declares secrets but is absent from ${file}'s matrix`);
      assert.equal(entry.config, `${module}/wrangler.toml`);
    }
  });

  test(`${file}: every required secret name is exported to sync-secrets.sh`, () => {
    for (const { module, required } of modulesWithSecrets()) {
      for (const name of required[env] ?? []) {
        assert.ok(
          exported.has(name),
          `${module}/.secrets.json requires ${name} for "${env}" but ${file} never sets it in the sync-secrets env block`
        );
      }
    }
  });
}
