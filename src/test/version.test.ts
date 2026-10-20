import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageVersion } from "../version.js";

test("readPackageVersion returns the version field of a package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "version-test-"));
  try {
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ version: "9.9.9" }));
    assert.equal(readPackageVersion(file), "9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
