import { test } from "node:test";
import assert from "node:assert/strict";
import { modeOf, OPERATION_MODES, READONLY_QUERY_EXPOSED, READONLY_QUERY_TOOL, type Mode } from "../mux/policy.js";

const EXPECTED: ReadonlyArray<readonly [Mode, readonly string[]]> = [
  ["none", ["search_docs"]],
  ["all", ["list_organizations", "list_projects"]],
  [
    "one",
    [
      "create_project",
      "pause_project",
      "restore_project",
      "create_branch",
      "delete_branch",
      "merge_branch",
      "reset_branch",
      "rebase_branch",
      "apply_migration",
      "deploy_edge_function",
      "update_storage_config",
      "confirm_cost",
      "get_cost",
      "execute_sql",
    ],
  ],
  [
    "locate",
    [
      "get_organization",
      "get_project",
      "list_branches",
      "list_tables",
      "list_extensions",
      "list_migrations",
      "query_logs",
      "get_advisors",
      "get_project_url",
      "get_publishable_keys",
      "generate_typescript_types",
      "list_edge_functions",
      "get_edge_function",
      "list_notebooks",
      "get_notebook",
      "list_storage_buckets",
      "get_storage_config",
    ],
  ],
];

test("modeOf returns the listed mode for each of the 34 official tools", () => {
  for (const [mode, names] of EXPECTED) {
    for (const name of names) {
      assert.equal(modeOf(name), mode, name);
    }
  }
});

test("the table holds exactly the 34 official names, without get_logs or create_edge_function_secret", () => {
  const names = EXPECTED.flatMap(([, list]) => list);
  assert.equal(names.length, 34);
  assert.equal(new Set(names).size, 34);
  assert.equal(OPERATION_MODES.size, 34);
  assert.deepEqual([...OPERATION_MODES.keys()].sort(), [...names].sort());
  assert.equal(OPERATION_MODES.has("get_logs"), false);
  assert.equal(OPERATION_MODES.has("create_edge_function_secret"), false);
});

test("names the table does not list resolve to one, including inherited names", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "not_a_tool"]) {
    assert.equal(modeOf(name), "one", name);
  }
});

test("the read-only query tool is named and not exposed", () => {
  assert.equal(READONLY_QUERY_TOOL, "execute_sql_readonly");
  assert.equal(READONLY_QUERY_EXPOSED, false);
});
