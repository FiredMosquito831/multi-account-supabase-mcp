import { test } from "node:test";
import assert from "node:assert/strict";
import { noteFor, withAccountParam } from "../mux/catalog.js";
import type { OfficialTool } from "../mux/children.js";
import { OPERATION_MODES } from "../mux/policy.js";

// The note of each mode, copied from the brief. The texts are exact, so the tests compare whole strings.
const NOTE_ALL =
  'Accounts: "account" may be one name, a comma list, or "all". Lists and "all" run on every named account and return one entry per account.';
const NOTE_LOCATE =
  'Accounts: "account" may be one name, a comma list, or "all". Every named account is asked. Only the account that owns the id answers. Accounts without it are listed under notFoundIn.';
const NOTE_ONE =
  'Accounts: this tool can change data, so it runs on one account only. Name one account in "account". A list or "all" is refused.';

// A tool with placeholder values. The test gives its name, and passes the mode to the function itself.
function sampleTool(name = "list_tables"): OfficialTool {
  return {
    name,
    description: "A tool with a placeholder description.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
    annotations: { readOnlyHint: true },
  };
}

const propertiesOf = (tool: OfficialTool): Record<string, unknown> =>
  tool.inputSchema.properties as Record<string, unknown>;

test("noteFor returns the exact text of each mode", () => {
  assert.equal(noteFor("all"), NOTE_ALL);
  assert.equal(noteFor("locate"), NOTE_LOCATE);
  assert.equal(noteFor("one"), NOTE_ONE);
});

test("a tool of mode none is returned unchanged, and the tool given is not changed", () => {
  const searchDocs: OfficialTool = {
    name: "search_docs",
    description: "Searches the Supabase documentation.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  };
  const before = structuredClone(searchDocs);
  const result = withAccountParam(searchDocs, "none", ["alpha", "beta"]);
  assert.equal(result, searchDocs);
  assert.deepEqual(result, before);
  assert.deepEqual(searchDocs, before);
});

test("the account property goes on every policy tool except search_docs, which is returned unchanged", () => {
  for (const [name, mode] of OPERATION_MODES) {
    const tool = sampleTool(name);
    const result = withAccountParam(tool, mode, ["alpha"]);
    if (name === "search_docs") {
      assert.equal(mode, "none");
      assert.equal(result, tool);
    } else {
      assert.ok(Object.hasOwn(propertiesOf(result), "account"), name);
    }
  }
});

test("each mode's note ends the description, after the original text and a blank line", () => {
  const cases = [
    ["all", NOTE_ALL],
    ["locate", NOTE_LOCATE],
    ["one", NOTE_ONE],
  ] as const;
  for (const [mode, note] of cases) {
    const result = withAccountParam(sampleTool(), mode, ["alpha"]);
    assert.equal(result.description, `A tool with a placeholder description.\n\n${note}`, mode);
  }
});

test("the account property lists the known accounts, joined with a comma and a space", () => {
  const result = withAccountParam(sampleTool(), "one", ["alpha", "beta"]);
  assert.deepEqual(propertiesOf(result).account, {
    type: "string",
    description: 'The account to use: one name, a comma list of names, or "all". Known accounts: alpha, beta.',
  });
});

test("with no accounts the account property says none yet", () => {
  const result = withAccountParam(sampleTool(), "all", []);
  assert.deepEqual(propertiesOf(result).account, {
    type: "string",
    description: 'The account to use: one name, a comma list of names, or "all". Known accounts: none yet.',
  });
});

test("required and the other parts of the schema stay as they were", () => {
  const result = withAccountParam(sampleTool(), "locate", ["alpha"]);
  assert.deepEqual(result.inputSchema.required, ["project_id"]);
  assert.equal(result.inputSchema.type, "object");
  assert.deepEqual(propertiesOf(result).project_id, { type: "string" });
  assert.equal(result.name, "list_tables");
  assert.deepEqual(result.annotations, { readOnlyHint: true });
});

test("withAccountParam does not change the tool it is given", () => {
  const tool = sampleTool();
  const before = structuredClone(tool);
  const result = withAccountParam(tool, "one", ["alpha", "beta"]);
  assert.deepEqual(tool, before);
  assert.notEqual(result, tool);
  assert.notEqual(result.inputSchema, tool.inputSchema);
  assert.notEqual(propertiesOf(result), propertiesOf(tool));
});

test("a tool without a description has the note as its whole description", () => {
  const tool: OfficialTool = { name: "list_projects", inputSchema: { type: "object", properties: {} } };
  const result = withAccountParam(tool, "all", ["alpha"]);
  assert.equal(result.description, NOTE_ALL);
  assert.equal(tool.description, undefined);
});

test("the mode given decides the note, whatever name the tool has", () => {
  const result = withAccountParam(sampleTool("search_docs"), "one", ["alpha"]);
  assert.ok(Object.hasOwn(propertiesOf(result), "account"));
  assert.equal(result.description, `A tool with a placeholder description.\n\n${NOTE_ONE}`);
});
