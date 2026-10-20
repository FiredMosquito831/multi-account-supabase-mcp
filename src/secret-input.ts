// Reads a secret that the owner types in a terminal. The keys are read one at a time, and nothing is echoed. The input
// and the output are parameters, so the tests run the reader with fakes.

const CANCELLED = "Cancelled.";
const COULD_NOT_READ = "Could not read the token.";

// An escape sequence, such as an arrow key, or a lone escape. It is removed from each chunk before the keys are read.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -\/]*[@-~]|O.)?/g;

type SecretEvent = "data" | "end" | "error";

// The members of a readable stream that the reader uses. process.stdin has all of them.
export type SecretInput = {
  readonly isTTY: boolean;
  readonly isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: SecretEvent, listener: (chunk: unknown) => void): unknown;
  removeListener(event: SecretEvent, listener: (chunk: unknown) => void): unknown;
};

// The member of a writable stream that the reader uses. process.stderr has it.
export type SecretOutput = {
  write(text: string): unknown;
};

// Turns raw mode on or off. A stream that refuses the change gets the fixed message, not the stream's own text.
const setRaw = (input: SecretInput, mode: boolean): void => {
  try {
    input.setRawMode(mode);
  } catch {
    throw new Error(COULD_NOT_READ);
  }
};

// Reads the typed text up to Enter. Backspace removes one character. Ctrl+C or the end of the input cancels, and an
// input error gives the fixed message. The newline that ends the prompt line is written in the finally block, so it is
// written whatever the outcome. No typed text is ever written.
export const readSecretFrom = async (input: SecretInput, output: SecretOutput): Promise<string> => {
  const wasRaw = input.isRaw === true;
  let rawOn = false;
  let typed = "";
  let settled = false;
  let settle: (error: Error | undefined, value: string) => void = () => undefined;

  const onData = (chunk: unknown): void => {
    if (settled) {
      return;
    }
    // The escape sequences in this chunk are removed first. The other keys in the same chunk are still read.
    const text = String(chunk).replace(ESCAPE_SEQUENCE, "");
    for (const key of text) {
      if (key === "\r" || key === "\n") {
        settle(undefined, typed);
        return;
      }
      if (key === "\u0003") {
        settle(new Error(CANCELLED), "");
        return;
      }
      if (key === "\u007f" || key === "\b") {
        typed = [...typed].slice(0, -1).join("");
      } else if (key >= " ") {
        typed += key;
      }
    }
  };
  const onEnd = (): void => {
    settle(new Error(CANCELLED), "");
  };
  const onError = (): void => {
    // The error itself is not passed on, because its text may hold internal detail.
    settle(new Error(COULD_NOT_READ), "");
  };

  try {
    if (input.isTTY !== true) {
      throw new Error(COULD_NOT_READ);
    }
    setRaw(input, true);
    rawOn = true;
    const outcome = new Promise<string>((resolve, reject) => {
      settle = (error, value) => {
        settled = true;
        if (error === undefined) {
          resolve(value);
        } else {
          reject(error);
        }
      };
    });
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
    return await outcome;
  } finally {
    try {
      if (rawOn) {
        setRaw(input, wasRaw);
      }
    } finally {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.pause();
      output.write("\n");
    }
  }
};
