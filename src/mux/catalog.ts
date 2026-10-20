import type { OfficialTool } from "./children.js";
import type { Mode } from "./policy.js";

// The notes that end the description of a tool. Each one tells the model how the account argument behaves in its mode.
// The texts are exact.
const NOTE_ALL =
  'Accounts: "account" may be one name, a comma list, or "all". Lists and "all" run on every named account and return one entry per account.';
const NOTE_LOCATE =
  'Accounts: "account" may be one name, a comma list, or "all". Every named account is asked. Only the account that owns the id answers. Accounts without it are listed under notFoundIn.';
const NOTE_ONE =
  'Accounts: this tool can change data, so it runs on one account only. Name one account in "account". A list or "all" is refused.';

// The note of a mode. A tool of mode none has no note, because withAccountParam returns it unchanged.
export function noteFor(mode: Mode): string {
  switch (mode) {
    case "all":
      return NOTE_ALL;
    case "locate":
      return NOTE_LOCATE;
    case "one":
      return NOTE_ONE;
    case "none":
      return "";
  }
}

// The description of the account property. It lists the known accounts, or says that there are none yet.
function accountDescription(accounts: readonly string[]): string {
  const known = accounts.length > 0 ? accounts.join(", ") : "none yet";
  return `The account to use: one name, a comma list of names, or "all". Known accounts: ${known}.`;
}

// Returns the tool with the optional account argument added to its properties, and the note of its mode as the last
// paragraph of its description. A tool of mode none is returned as it is. The tool given is not changed: the result
// holds new objects where the schema changes, and required is kept as it was.
export function withAccountParam(tool: OfficialTool, mode: Mode, accounts: readonly string[]): OfficialTool {
  if (mode === "none") {
    return tool;
  }
  const note = noteFor(mode);
  const original = tool.description ?? "";
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  return {
    ...tool,
    // A tool without a description has the note as its whole description, so no blank line leads it.
    description: original === "" ? note : `${original}\n\n${note}`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        account: { type: "string", description: accountDescription(accounts) },
      },
    },
  };
}
