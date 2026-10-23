import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { usageText } from "../usage.js";

// This file runs from dist/test, so two levels up is the repository root.
const root = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_DIR = "plugins/multi-account-supabase";
const COMMANDS_DIR = `${PLUGIN_DIR}/commands`;
const manifest = JSON.parse(readFileSync(join(root, PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
  version: string;
};
const VERSION = manifest.version;

const FILES = ["accounts", "doctor", "add-account", "set-default", "remove-account"];
const LAUNCHER = 'node "${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"';
const BANG_LIST = `!\`${LAUNCHER} list\``;
const BANG_DOCTOR = `!\`${LAUNCHER} doctor\``;

const readCommand = (name: string): string => readFileSync(join(root, COMMANDS_DIR, `${name}.md`), "utf8");

const frontmatter = (text: string): string | undefined => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];

test("each command file has a frontmatter description with a value", () => {
  for (const name of FILES) {
    const fm = frontmatter(readCommand(name));
    assert.ok(fm, `${name}.md has a frontmatter block`);
    const description = /^description:[ \t]*(\S.*)$/m.exec(fm);
    assert.ok(description, `${name}.md has a description`);
  }
});

test("accounts.md and doctor.md allow only node in their ! line", () => {
  for (const name of ["accounts", "doctor"]) {
    const fm = frontmatter(readCommand(name));
    assert.ok(fm, `${name}.md has a frontmatter block`);
    assert.match(fm, /^allowed-tools:[ \t]*Bash\(node:\*\)[ \t]*$/m, `${name}.md allows Bash(node:*)`);
  }
});

test("the only ! lines are the launcher's list and doctor lines, one each in accounts.md and doctor.md", () => {
  const expected: Record<string, string | undefined> = {
    accounts: BANG_LIST,
    doctor: BANG_DOCTOR,
    "add-account": undefined,
    "set-default": undefined,
    "remove-account": undefined,
  };
  for (const name of FILES) {
    const text = readCommand(name);
    const line = expected[name];
    const bangLines = text.split(/\r?\n/).filter((item) => item.startsWith("!"));
    assert.deepEqual(bangLines, line === undefined ? [] : [line], `${name}.md has the expected ! line`);
    // Any other inline command, with the bang and a backtick, anywhere in the text, is refused too.
    const bangCount = text.split("!`").length - 1;
    assert.equal(bangCount, line === undefined ? 0 : 1, `${name}.md has no other !\` command`);
  }
});

test("no command file has $ARGUMENTS, $1, or a $ other than ${CLAUDE_PLUGIN_ROOT}", () => {
  for (const name of FILES) {
    assert.doesNotMatch(readCommand(name), /\$(?!\{CLAUDE_PLUGIN_ROOT\})/, `${name}.md has no user-text placeholder`);
  }
});

test("no command file contains a token-shaped string", () => {
  for (const name of FILES) {
    const text = readCommand(name);
    assert.equal(text.includes("sbp_"), false, `${name}.md has no sbp_ text`);
    assert.doesNotMatch(text, /[A-Za-z0-9]{24,}/, `${name}.md has no 24-character run of letters and digits`);
  }
});

// A terminal line starts with this, as a whole line, after the list marker or code-span backtick is removed.
const PREFIX = "npx -y multi-account-supabase-mcp@";

// Each line of a file, trimmed, with one list marker or one code-span backtick removed at each end.
const wholeLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*>]\s+|`)/, "").replace(/`$/, "").trim());

const terminalLines = (text: string): string[] => wholeLines(text).filter((line) => line.startsWith(PREFIX));

test("each command file that has a terminal line gives the plugin version as its literal", () => {
  for (const name of FILES) {
    for (const line of terminalLines(readCommand(name))) {
      assert.ok(line.startsWith(`${PREFIX}${VERSION} `), `${name}.md names the plugin version ${VERSION} as its literal`);
    }
  }
});

test("every multi-account-supabase-mcp@<version> in a command file is the plugin version, after npx -y", () => {
  for (const name of FILES) {
    const text = readCommand(name);
    for (const match of text.matchAll(/multi-account-supabase-mcp@([^\s`'"]*)/g)) {
      const index = match.index ?? 0;
      assert.ok(text.slice(0, index).endsWith("npx -y "), `${name}.md uses the npx form for its terminal line`);
      assert.equal(match[1], VERSION, `${name}.md names the plugin version as a literal`);
    }
  }
});

test("add-account, set-default and remove-account each give their npx terminal line as a whole line, with the literal version", () => {
  const lines: Record<string, string> = {
    "add-account": `npx -y multi-account-supabase-mcp@${VERSION} add <name> --pat`,
    "set-default": `npx -y multi-account-supabase-mcp@${VERSION} default <name>`,
    "remove-account": `npx -y multi-account-supabase-mcp@${VERSION} remove <name>`,
  };
  for (const [name, line] of Object.entries(lines)) {
    assert.ok(wholeLines(readCommand(name)).includes(line), `${name}.md has the terminal line ${line} as a whole line`);
  }
});

test("remove-account.md asks the owner to confirm the name in the chat before it gives the terminal line", () => {
  const text = readCommand("remove-account");
  const ask = text.indexOf("ask the owner in this chat to confirm the name");
  const line = text.indexOf(`npx -y multi-account-supabase-mcp@${VERSION} remove <name>`);
  assert.ok(ask >= 0, "remove-account.md has the chat confirmation sentence");
  assert.ok(line >= 0, "remove-account.md has the remove terminal line");
  assert.ok(ask < line, "the chat confirmation comes before the terminal line");
});

test("remove-account.md says the Supabase token still works until it is revoked", () => {
  assert.match(readCommand("remove-account"), /Supabase token still works until [^.]*revoke/);
});

test("remove-account.md says the CLI asks in the terminal before it removes, and needs --yes without a terminal", () => {
  const text = readCommand("remove-account");
  assert.ok(
    text.includes("The CLI asks in the terminal before it removes the account, and the owner types y there."),
    "remove-account.md says the CLI asks in the terminal, and the owner types y",
  );
  assert.ok(
    text.includes("Without a terminal, the command needs `--yes` after the name."),
    "remove-account.md says --yes is needed without a terminal",
  );
  assert.equal(
    text.includes("does not ask for a confirmation"),
    false,
    "remove-account.md no longer says the CLI removes at once without asking",
  );
});

test("add-account.md names the --pat option", () => {
  assert.ok(readCommand("add-account").includes("--pat"));
});

// The command names the CLI usage text lists: two spaces, then the name, in the Commands section.
const listedCommands = (usage: string): string[] => {
  const section = usage.slice(usage.indexOf("Commands:"), usage.indexOf("Options for"));
  return section.split("\n").flatMap((line) => {
    const name = /^ {2}([a-z][a-z-]*)\b/.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });
};

// The verb a terminal line runs: the word after the package version.
const terminalVerbs = (name: string): string[] =>
  terminalLines(readCommand(name)).map((line) => line.slice(PREFIX.length).split(" ")[1]);

// The verb a ! line runs: the word after launch.mjs, before the closing backtick.
const bangVerb = (name: string): string | undefined => {
  const line = readCommand(name).split(/\r?\n/).find((item) => item.startsWith("!"));
  return /launch\.mjs" ([a-z]+)`$/.exec(line ?? "")?.[1];
};

// The verbs that the usage text does not list. An undefined verb is never listed.
const unlisted = (verbs: (string | undefined)[], listed: string[]): (string | undefined)[] =>
  verbs.filter((verb) => verb === undefined || !listed.includes(verb));

test("every verb the command files run is listed in the CLI usage text", () => {
  const verbs = [
    ...terminalVerbs("add-account"),
    ...terminalVerbs("set-default"),
    ...terminalVerbs("remove-account"),
    bangVerb("accounts"),
    bangVerb("doctor"),
  ];
  assert.equal(verbs.length, 5, "the three terminal lines and the two ! lines were all found");
  assert.deepEqual(unlisted(verbs, listedCommands(usageText)), [], "every verb is in the usage text");
});

test("the verb check reports a verb the usage text does not list", () => {
  assert.deepEqual(unlisted(["add", "bogus", undefined], listedCommands(usageText)), ["bogus", undefined]);
});
