import path from "node:path";

const APP_FOLDER = "multi-account-supabase-mcp";

// The environment, the platform and the home directory are parameters, so a test can check the rule for
// any platform without reading the real environment. A variable set to "" counts as unset.
export const dataFolder = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string => {
  if (env.MULTI_ACCOUNT_SUPABASE_HOME) {
    return env.MULTI_ACCOUNT_SUPABASE_HOME;
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    return path.win32.join(localAppData, APP_FOLDER);
  }
  // path.posix, not path: on a Windows host path.join turns "/" into "\", which is wrong for a Linux path.
  const dataHome = env.XDG_DATA_HOME || path.posix.join(homeDir, ".local", "share");
  return path.posix.join(dataHome, APP_FOLDER);
};

// Whether a path names a place without depending on the working folder. On Windows the path needs a drive letter,
// or be a network share, written with either kind of slash, such as \\server\share or //server/share. A path that
// starts with one separator depends on the current drive, so it is not absolute. Elsewhere a leading slash is enough.
// The platform is a parameter for tests.
export const isAbsoluteLocation = (p: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === "win32" ? /^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/.test(p) : p.startsWith("/");
