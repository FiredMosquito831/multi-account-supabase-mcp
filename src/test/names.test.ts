import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValidName } from "../accounts/names.js";

const invalidMessage = (name: string): string =>
  `Invalid account name "${name}". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.`;

for (const name of ["work", "a", "0-day", "a".repeat(32)]) {
  test(`accepts the account name ${name}`, () => {
    assert.equal(assertValidName(name), name);
  });
}

for (const name of ["", "All", "has space", "a".repeat(33), "-leading", "under_score", "ünï"]) {
  test(`refuses ${JSON.stringify(name)} with the invalid-name message`, () => {
    assert.throws(() => assertValidName(name), { message: invalidMessage(name) });
  });
}

test('refuses "all" with the reserved message', () => {
  assert.throws(() => assertValidName("all"), {
    message: '"all" is reserved. Pick another account name.',
  });
});
