import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modeOf, OPERATION_MODES } from "../mux/policy.js";

type FixtureTool = { name: string; annotations?: { readOnlyHint?: boolean } };

// The compiled test runs from dist/test, so ../../ is the repository root.
const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/official-tools.json", import.meta.url), "utf8"),
) as FixtureTool[];

test("the policy table has exactly the fixture's tool names", () => {
  const fixtureNames = fixture.map((tool) => tool.name).sort();
  const tableNames = [...OPERATION_MODES.keys()].sort();
  assert.deepEqual(tableNames, fixtureNames);
});

test("every fixture tool with readOnlyHint false is mode one", () => {
  const writes = fixture.filter((tool) => tool.annotations?.readOnlyHint === false);
  assert.ok(writes.length > 0);
  for (const tool of writes) {
    assert.equal(modeOf(tool.name), "one", tool.name);
  }
});

test("the only read-only fixture tools in mode one are confirm_cost and get_cost", () => {
  const readOnlyOne = fixture
    .filter((tool) => tool.annotations?.readOnlyHint === true && modeOf(tool.name) === "one")
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(readOnlyOne, ["confirm_cost", "get_cost"]);
});
