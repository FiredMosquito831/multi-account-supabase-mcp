import { test } from "node:test";
import assert from "node:assert/strict";
import { dataFolder } from "../paths.js";

// The environment is passed in, so these tests never read the real one.
const WIN_HOME = "C:\\Users\\u";
const WIN_LOCAL = "C:\\Users\\u\\AppData\\Local";
const POSIX_HOME = "/home/u";

const OVERRIDE_CASES = [
  ["win32", WIN_HOME, "D:\\custom\\home"],
  ["linux", POSIX_HOME, "/custom/home"],
  ["darwin", POSIX_HOME, "/custom/home"],
] as const;

for (const [platform, home, override] of OVERRIDE_CASES) {
  test(`MULTI_ACCOUNT_SUPABASE_HOME wins on ${platform}`, () => {
    const env = {
      MULTI_ACCOUNT_SUPABASE_HOME: override,
      LOCALAPPDATA: WIN_LOCAL,
      XDG_DATA_HOME: "/srv/xdg",
    };
    assert.equal(dataFolder(env, platform, home), override);
  });
}

test("win32 with LOCALAPPDATA set uses LOCALAPPDATA", () => {
  // A value the home folder does not produce, so ignoring LOCALAPPDATA fails this test.
  assert.equal(
    dataFolder({ LOCALAPPDATA: "D:\\Data\\Local" }, "win32", WIN_HOME),
    "D:\\Data\\Local\\multi-account-supabase-mcp",
  );
});

test("win32 without LOCALAPPDATA uses AppData\\Local under the home folder", () => {
  assert.equal(
    dataFolder({}, "win32", WIN_HOME),
    "C:\\Users\\u\\AppData\\Local\\multi-account-supabase-mcp",
  );
});

test("linux with XDG_DATA_HOME set uses XDG_DATA_HOME", () => {
  assert.equal(
    dataFolder({ XDG_DATA_HOME: "/srv/xdg" }, "linux", POSIX_HOME),
    "/srv/xdg/multi-account-supabase-mcp",
  );
});

test("linux without XDG_DATA_HOME uses .local/share under the home folder", () => {
  assert.equal(
    dataFolder({}, "linux", POSIX_HOME),
    "/home/u/.local/share/multi-account-supabase-mcp",
  );
});

test("darwin follows the same rule as linux", () => {
  assert.equal(
    dataFolder({ XDG_DATA_HOME: "/srv/xdg" }, "darwin", POSIX_HOME),
    "/srv/xdg/multi-account-supabase-mcp",
  );
  assert.equal(
    dataFolder({}, "darwin", POSIX_HOME),
    "/home/u/.local/share/multi-account-supabase-mcp",
  );
});

test("a variable set to the empty string counts as unset", () => {
  assert.equal(
    dataFolder({ MULTI_ACCOUNT_SUPABASE_HOME: "", XDG_DATA_HOME: "" }, "linux", POSIX_HOME),
    "/home/u/.local/share/multi-account-supabase-mcp",
  );
  assert.equal(
    dataFolder({ MULTI_ACCOUNT_SUPABASE_HOME: "", LOCALAPPDATA: "" }, "win32", WIN_HOME),
    "C:\\Users\\u\\AppData\\Local\\multi-account-supabase-mcp",
  );
});
