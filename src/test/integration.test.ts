import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { ALL_FEATURES, PLACEHOLDER_TOKEN } from "../mux/children.js";
import type { ChildClient } from "../mux/children.js";
import { startStdioChild } from "../mux/official-child.js";

// The feature groups both children are started with: every group except docs. The docs group lists search_docs, and
// the server loads that tool's schema from the content API. Leaving docs out keeps this test offline.
const FEATURES = ["account", "database", "debugging", "development", "functions", "branching", "storage", "notebooks"];

// The official server lists 34 tools in all. Without docs, the writable child lists 33 of them.
const WRITABLE_TOOL_COUNT = 33;

// The read-only child hides eleven write tools from its list, so it lists 22. execute_sql stays listed.
const READ_ONLY_TOOL_COUNT = 22;

// The text of a tool result. Its text blocks are joined in order.
function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

// The names of the tools a child lists.
async function namesOf(child: ChildClient): Promise<string[]> {
  return (await child.listTools()).map((tool) => tool.name);
}

test(
  "the official server over stdio lists its tools writable and read-only, and refuses a write when read-only, offline",
  { timeout: 60_000 },
  async () => {
    assert.deepEqual(FEATURES, ALL_FEATURES.filter((group) => group !== "docs"));

    let writable: ChildClient | undefined;
    let readOnly: ChildClient | undefined;
    try {
      writable = await startStdioChild({
        account: null,
        readOnly: false,
        token: PLACEHOLDER_TOKEN,
        features: FEATURES,
      });
      readOnly = await startStdioChild({
        account: null,
        readOnly: true,
        token: PLACEHOLDER_TOKEN,
        features: FEATURES,
      });

      // The messages carry the names, so a failing count shows which tools the child listed.
      const writableNames = await namesOf(writable);
      const writableListing = `The writable child lists: ${writableNames.join(", ")}`;
      assert.equal(writableNames.length, WRITABLE_TOOL_COUNT, writableListing);
      assert.ok(writableNames.includes("create_project"), writableListing);
      assert.ok(writableNames.includes("execute_sql"), writableListing);

      const readOnlyNames = await namesOf(readOnly);
      const readOnlyListing = `The read-only child lists: ${readOnlyNames.join(", ")}`;
      assert.equal(readOnlyNames.length, READ_ONLY_TOOL_COUNT, readOnlyListing);
      assert.ok(!readOnlyNames.includes("create_project"), readOnlyListing);
      assert.ok(readOnlyNames.includes("execute_sql"), readOnlyListing);

      // pause_project is a hidden write tool. The server still runs its handler, and the handler refuses the call
      // before it reaches the Management API.
      const refusal = await readOnly.callTool("pause_project", { project_id: "abc" }, 60_000);
      assert.equal(refusal.isError, true, `The read-only child answered: ${textOf(refusal)}`);
      assert.match(textOf(refusal), /read-only mode/);
    } finally {
      // Both children are closed even when an assertion fails. A failure to close the read-only child still lets the
      // writable child close.
      try {
        await readOnly?.close();
      } finally {
        await writable?.close();
      }
    }
  },
);
