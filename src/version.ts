import { readFileSync } from "node:fs";

export const readPackageVersion = (packageJsonPath: string): string =>
  JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;
