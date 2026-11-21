// registry-manifest-alias: the CLI's argument and identity gates, all of which fail before any
// registry call. Run: node --test scripts/registry-manifest-alias.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { guardTree } from "./test-tree.mjs";

guardTree();

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "registry-manifest-alias.mjs");
const MAP = { stable_tag: "v1.2.3", images: { "acme/web": { digest: `sha256:${"a".repeat(64)}` } } };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "registry-alias-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "map.json");
  const raw = JSON.stringify(MAP);
  writeFileSync(file, raw);
  return { file, hash: createHash("sha256").update(raw).digest("hex") };
}

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });

function args(f, over = {}) {
  const o = { map: f.file, hash: f.hash, repo: "acme/web", source: "v1.2.3", target: "latest", ...over };
  return ["--candidate-map", o.map, "--expected-map-sha256", o.hash, "--repository", o.repo, "--source-tag", o.source, "--target-tag", o.target];
}

test("an unknown flag is an internal error (exit 2)", (t) => {
  const r = run([...args(fixture(t)), "--nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[internal\].*unknown argument: --nope/);
});

test("a missing required flag prints usage (exit 2)", (t) => {
  const f = fixture(t);
  const r = run(args(f).slice(0, -2));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: registry-manifest-alias\.mjs/);
});

test("a malformed map hash prints usage (exit 2)", (t) => {
  const r = run(args(fixture(t), { hash: "abc" }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("a map whose hash differs is an identity failure (exit 4)", (t) => {
  const r = run(args(fixture(t), { hash: "0".repeat(64) }));
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\[identity\].*hash mismatch/);
});

test("a repository absent from the frozen map is an identity failure (exit 4)", (t) => {
  const r = run(args(fixture(t), { repo: "acme/other" }));
  assert.equal(r.status, 4);
  assert.match(r.stderr, /not present in the frozen candidate map/);
});

test("a source tag that is not the map's stable_tag is an identity failure (exit 4)", (t) => {
  const r = run(args(fixture(t), { source: "v9.9.9" }));
  assert.equal(r.status, 4);
  assert.match(r.stderr, /does not match source v9\.9\.9/);
});
