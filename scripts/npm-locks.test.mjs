// npm-locks: the npm lockfile inventory behind gate:licenses and the SBOM. Run: node --test scripts/npm-locks.test.mjs
//
// Lockfiles are planted in a throwaway git repository because npmLockfiles reads `git ls-files`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { npmLockfiles, npmLockInventory, npmLockPackages } from "./npm-locks.mjs";
import { guardTree } from "./test-tree.mjs";

guardTree();

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "npm-locks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function put(dir, rel, content) {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const track = (dir) => execFileSync("git", ["add", "-A"], { cwd: dir });
const lock = (packages) => JSON.stringify({ lockfileVersion: 3, packages });

test("npmLockPackages skips the root and links and maps licence shapes", (t) => {
  const dir = repo(t);
  put(dir, "package-lock.json", lock({
    "": { name: "root", version: "1.0.0" },
    "node_modules/linked": { link: true, resolved: "../linked" },
    "node_modules/a": { version: "1.0.0", license: "MIT" },
    "node_modules/b": { version: "2.0.0", license: { type: "ISC" }, dev: true },
    "node_modules/c": { version: "3.0.0" },
    "node_modules/x/node_modules/@s/d": { version: "4.0.0", license: "Apache-2.0" },
    "node_modules/e": { name: "renamed", license: "MIT" },
  }));
  assert.deepEqual(npmLockPackages(join(dir, "package-lock.json")), [
    { name: "a", version: "1.0.0", license: "MIT", dev: false },
    { name: "b", version: "2.0.0", license: "ISC", dev: true },
    { name: "c", version: "3.0.0", license: "Unknown", dev: false },
    { name: "@s/d", version: "4.0.0", license: "Apache-2.0", dev: false },
    { name: "renamed", version: "NOASSERTION", license: "MIT", dev: false },
  ]);
});

test("npmLockPackages rejects a lockfile with no packages map", (t) => {
  const dir = repo(t);
  put(dir, "package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
  assert.throws(() => npmLockPackages(join(dir, "package-lock.json")), /lockfileVersion 1 has no "packages" map/);
});

test("npmLockfiles returns tracked locks, sorted, minus .gateignore subtrees and deleted files", (t) => {
  const dir = repo(t);
  put(dir, "package-lock.json", lock({}));
  put(dir, "clients/terminal/package-lock.json", lock({}));
  put(dir, "vendored/app/package-lock.json", lock({}));
  put(dir, "vendored/.gateignore", "");
  put(dir, "gone/package-lock.json", lock({}));
  put(dir, "untracked-later/readme.md", "x");
  track(dir);
  rmSync(join(dir, "gone/package-lock.json"));
  put(dir, "untracked/package-lock.json", lock({}));
  assert.deepEqual(npmLockfiles(dir), ["clients/terminal/package-lock.json", "package-lock.json"]);
});

test("npmLockfiles returns [] outside a git repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "npm-locks-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  put(dir, "package-lock.json", lock({}));
  assert.deepEqual(npmLockfiles(dir), []);
});

test("npmLockInventory dedups by name@version and records every lock that has it", (t) => {
  const dir = repo(t);
  put(dir, "package-lock.json", lock({ "node_modules/a": { version: "1.0.0", license: "MIT" } }));
  put(dir, "sub/package-lock.json", lock({
    "node_modules/a": { version: "1.0.0", license: "MIT" },
    "node_modules/a2": { name: "a", version: "2.0.0", license: "MIT" },
  }));
  track(dir);
  const inv = npmLockInventory(dir);
  assert.deepEqual(inv.locks, ["package-lock.json", "sub/package-lock.json"]);
  assert.equal(inv.packages.length, 2);
  assert.deepEqual(inv.packages.find((p) => p.version === "1.0.0").locks, ["package-lock.json", "sub/package-lock.json"]);
  assert.deepEqual(inv.packages.find((p) => p.version === "2.0.0").locks, ["sub/package-lock.json"]);
});
