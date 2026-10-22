import { test } from "node:test";
import assert from "node:assert/strict";
import { ISOLATED_VARIABLES, assertIsolated, inTemporaryRoot } from "./isolation.js";

// The seven variables that every test sets to a temporary folder. A list that loses a name, or gains one, fails this test.
test("the isolated variables are exactly the seven names that every test sets", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    assert.deepEqual([...ISOLATED_VARIABLES].sort(), [
      "APPDATA",
      "CODEX_HOME",
      "HOME",
      "LOCALAPPDATA",
      "MULTI_ACCOUNT_SUPABASE_HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
    ]);
  }));
