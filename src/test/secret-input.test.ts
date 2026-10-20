import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readSecretFrom } from "../secret-input.js";

// A fake terminal input. It is an event emitter, so a test sends keys by emitting data. It records each raw mode it is
// set to, and whether it is paused, so a test can check that the reader left the input as it found it.
class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  readonly rawCalls: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

// A fake output. It keeps each write, so a test can check exactly what was written.
class FakeOutput {
  readonly writes: string[] = [];

  write(text: string): boolean {
    this.writes.push(text);
    return true;
  }
}

// Starts a read, then sends each chunk as one data event. The listeners are attached before the read returns, so the
// chunks arrive while the read is waiting.
const readWith = (input: FakeInput, output: FakeOutput, chunks: string[]): Promise<string> => {
  const pending = readSecretFrom(input, output);
  for (const chunk of chunks) {
    input.emit("data", chunk);
  }
  return pending;
};

// What every read must leave behind. The only write is the newline that ends the prompt line, so no typed text is
// written. Raw mode is back at its start value, the input is paused, and no listener is left on it.
const assertLeftClean = (input: FakeInput, output: FakeOutput, startedRaw: boolean): void => {
  assert.deepEqual(output.writes, ["\n"]);
  assert.equal(input.isRaw, startedRaw);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
};

test("a token followed by an arrow key and Enter in one chunk gives the token, without the arrow key", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const token = await readWith(input, output, ["tok-SECRET-123\u001b[A\r"]);
  assert.equal(token, "tok-SECRET-123");
  assert.deepEqual(input.rawCalls, [true, false]);
  assertLeftClean(input, output, false);
});

test("an arrow key that arrives as its own chunk adds nothing to the token", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const token = await readWith(input, output, ["tok-SECRET-123", "\u001b[B", "\u001bOD", "\r"]);
  assert.equal(token, "tok-SECRET-123");
  assertLeftClean(input, output, false);
});

test("Backspace, sent as the delete code or as the backspace code, removes one character each time", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const token = await readWith(input, output, ["abcd\u007f\b\r"]);
  assert.equal(token, "ab");
  assertLeftClean(input, output, false);
});

test("keys that come after Enter are not read into the token", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const token = await readWith(input, output, ["tok\r", "not-part-of-it\r"]);
  assert.equal(token, "tok");
  assertLeftClean(input, output, false);
});

test("Ctrl+C rejects with Cancelled and returns no token", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  await assert.rejects(readWith(input, output, ["tok-SECRET", "\u0003"]), { message: "Cancelled." });
  assertLeftClean(input, output, false);
});

test("the end of the input rejects with Cancelled", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const pending = readSecretFrom(input, output);
  input.emit("data", "tok-SECRET");
  input.emit("end");
  await assert.rejects(pending, { message: "Cancelled." });
  assertLeftClean(input, output, false);
});

test("an input error rejects with the fixed message, and the error's own text is not passed on", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const pending = readSecretFrom(input, output);
  input.emit("error", new Error("low-level detail with tok-SECRET"));
  await assert.rejects(pending, { message: "Could not read the token." });
  assertLeftClean(input, output, false);
});

test("raw mode is restored to the value it had before the read, so a stream that started raw stays raw", async () => {
  const input = new FakeInput();
  input.isRaw = true;
  const output = new FakeOutput();
  const token = await readWith(input, output, ["tok\r"]);
  assert.equal(token, "tok");
  assert.deepEqual(input.rawCalls, [true, true]);
  assertLeftClean(input, output, true);
});

test("a terminal that refuses raw mode rejects with the fixed message, and the input is left as it was", async () => {
  const input = new FakeInput();
  input.setRawMode = () => {
    throw new Error("raw mode refused by the device");
  };
  const output = new FakeOutput();
  await assert.rejects(readWith(input, output, ["tok\r"]), { message: "Could not read the token." });
  assertLeftClean(input, output, false);
});

test("an input that is not a terminal is refused before any key is read", async () => {
  const input = new FakeInput();
  input.isTTY = false;
  const output = new FakeOutput();
  await assert.rejects(readWith(input, output, ["tok\r"]), { message: "Could not read the token." });
  assert.deepEqual(input.rawCalls, []);
  assertLeftClean(input, output, false);
});
