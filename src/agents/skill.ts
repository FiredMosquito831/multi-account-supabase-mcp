import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureFolders } from "./folders.js";
import type { Context } from "./types.js";

// The name of the skill. It is also the name of the folder that holds the skill in an agent's skill folder.
export const SKILL_NAME = "supabase-accounts";

// The file an agent reads as the skill. The text is copied from the package, so the copy matches the package's version.
export const SKILL_FILE = "SKILL.md";

// The text of the skill, read from the package. Adapters read it before they change anything, so a package without the file
// stops an install before the first change.
export const readSkillText = (packageRoot: string): Promise<string> =>
  readFile(path.join(packageRoot, "skills", SKILL_NAME, SKILL_FILE), "utf8");

// Copies the skill text from the package into the target folder, and returns the folder. The target folder and every missing folder
// above it are made with ensureFolders, one at a time, parents first. Once they exist, and before the file is written, the optional
// recordBeforeWrite callback is given the folders this call made, so the caller can record them and the file. A folder creation that
// fails calls nothing, because ensureFolders removes what it made and then throws. installSkill records nothing itself.
export const installSkill = async (
  ctx: Context,
  packageRoot: string,
  targetFolder: string,
  recordBeforeWrite?: (madeFolders: readonly string[]) => Promise<void>,
): Promise<string> => {
  const text = await readSkillText(packageRoot);
  const madeFolders = await ensureFolders(ctx, path.dirname(targetFolder), targetFolder);
  if (recordBeforeWrite !== undefined) {
    await recordBeforeWrite(madeFolders);
  }
  // SKILL.md is written without a backup, unlike the config files this tool edits. The reasons: this tool generates the file from
  // the text in the package and writes it whole, so every install replaces whatever the file holds. A backup written next to it
  // would stay in the skill folder on uninstall, because a folder is removed only when it is empty, and the folder would then be
  // left behind.
  await ctx.writeFile(path.join(targetFolder, SKILL_FILE), text);
  return targetFolder;
};

// Removes the skill file from the target folder, and then the folder when it is empty. Any other file in the folder is kept,
// so a folder that holds a file the owner wrote stays as it is. The caller decides whether this tool made the folder.
export const removeSkill = async (ctx: Context, targetFolder: string): Promise<void> => {
  await ctx.removeFile(path.join(targetFolder, SKILL_FILE));
  await ctx.removeDirIfEmpty(targetFolder);
};
