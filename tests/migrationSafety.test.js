import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = ["migrate.js", "models/hrm/migrate-hrm.js"];

for (const file of files) {
  test(`${file} does not contain destructive sync/drop operations`, async () => {
    const src = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(src, /\.sync\s*\(\s*\{[^}]*\bforce\s*:\s*true/);
    assert.doesNotMatch(src, /\.sync\s*\(\s*\{[^}]*\balter\s*:\s*true/);
    assert.doesNotMatch(src, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(src, /\bTRUNCATE\b/i);
    assert.doesNotMatch(src, /\.drop\s*\(/);
  });
}

test("hrm migration creates missing tables without force sync", async () => {
  const src = await readFile(
    path.join(root, "models/hrm/migrate-hrm.js"),
    "utf8",
  );
  assert.match(src, /CREATE DATABASE IF NOT EXISTS/);
  assert.match(src, /model\.sync\(\)/);
});
