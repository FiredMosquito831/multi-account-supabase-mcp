// 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit.
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const assertValidName = (name: string): string => {
  // "all" is the account argument that selects every account, so it cannot name one.
  if (name === "all") {
    throw new Error('"all" is reserved. Pick another account name.');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid account name "${name}". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.`,
    );
  }
  return name;
};
