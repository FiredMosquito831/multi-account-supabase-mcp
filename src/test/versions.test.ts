import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file runs from dist/test, so two levels up is the repository root. The paths are kept in this one
// place, and the test reads only these four files. A copy of the four files at the same paths can be
// checked by running the compiled test from the copy's folder.
const root = fileURLToPath(new URL("../../", import.meta.url));

const PACKAGE_JSON = "package.json";
const LOCK_FILE = "package-lock.json";
const PLUGIN_MANIFEST = "plugins/multi-account-supabase/.claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";

// Five values in four files. Each entry names the value, the file it is read from, and how to read it.
const VERSION_VALUES: Array<{ label: string; file: string; read: (json: any) => unknown }> = [
  { label: "package.json version", file: PACKAGE_JSON, read: (json) => json.version },
  { label: "package-lock.json version", file: LOCK_FILE, read: (json) => json.version },
  { label: 'package-lock.json packages[""].version', file: LOCK_FILE, read: (json) => json.packages[""].version },
  { label: "plugin.json version", file: PLUGIN_MANIFEST, read: (json) => json.version },
  { label: "marketplace.json metadata.version", file: MARKETPLACE, read: (json) => json.metadata.version },
];

const readJson = (file: string): any => JSON.parse(readFileSync(join(root, file), "utf8"));

test("the version fields in the four files are the same, and each one is a version string", () => {
  const found = VERSION_VALUES.map(({ label, file, read }) => ({ label, value: read(readJson(file)) }));
  for (const { label, value } of found) {
    assert.equal(typeof value, "string", `${label} is missing or is not text`);
    assert.notEqual(value, "", `${label} is empty`);
  }
  const listing = found.map(({ label, value }) => `${label} = ${value}`).join("; ");
  assert.equal(new Set(found.map(({ value }) => value)).size, 1, `the version fields differ: ${listing}`);
});
