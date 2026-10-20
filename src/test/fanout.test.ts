import { test } from "node:test";
import assert from "node:assert/strict";
import { FANOUT_LIMIT, mapWithLimit } from "../mux/fanout.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("10 items with limit 4 never have more than 4 in flight, and the results are in input order", async () => {
  assert.equal(FANOUT_LIMIT, 4);
  const items = Array.from({ length: 10 }, (_, index) => index);
  // inFlight is shared by every call, so peak is the most calls that ran at the same time.
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithLimit(items, FANOUT_LIMIT, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Later items sleep less, so they finish first. The results are in input order only if they are kept in that order.
    await sleep(10 - item);
    inFlight -= 1;
    return item * 10;
  });
  assert.equal(peak, FANOUT_LIMIT, "the peak must equal the limit: more is a breach, less means no overlap");
  assert.deepEqual(results, items.map((item) => item * 10));
});

// One call at a time, so the calls start in the order of the items. Item 1 fails, and items 2 and 3 still start,
// because a failure does not stop the later items.
test("a failed call does not stop the later items, and the fan-out rejects with that error", async () => {
  const started: number[] = [];
  await assert.rejects(
    mapWithLimit([0, 1, 2, 3], 1, async (item) => {
      started.push(item);
      if (item === 1) {
        throw new Error("fixture failure");
      }
      return item;
    }),
    { message: "fixture failure" },
  );
  assert.deepEqual(started, [0, 1, 2, 3]);
});

// The quick item fails at 5 ms while the slow item is still in flight. The slow item fails later, at 30 ms.
// The fan-out waits for the slow item, and rejects with the first error, which is the quick item's.
test("a call that fails while another is in flight: the fan-out waits, and rejects with the first error", async () => {
  const quickError = new Error("quick failure");
  const slowError = new Error("slow failure");
  let slowSettled = false;
  let slowRunningWhenQuickFailed = false;
  let slowSettledWhenRejected = false;
  let rejectedWith: unknown;
  await mapWithLimit(["quick", "slow"], 2, async (item) => {
    if (item === "quick") {
      await sleep(5);
      slowRunningWhenQuickFailed = !slowSettled;
      throw quickError;
    }
    await sleep(30);
    slowSettled = true;
    throw slowError;
  }).catch((error: unknown) => {
    rejectedWith = error;
    slowSettledWhenRejected = slowSettled;
  });
  assert.equal(slowRunningWhenQuickFailed, true, "the slow call must still be in flight when the quick one fails");
  assert.equal(slowSettledWhenRejected, true, "the slow call must settle before the promise rejects");
  assert.equal(rejectedWith, quickError, "the rejection must be the first error by identity, not the later one");
});

test("a limit that is not a whole number of at least 1 is refused before any call starts", async () => {
  let calls = 0;
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      mapWithLimit([1], limit, async (item) => {
        calls += 1;
        return item;
      }),
      RangeError,
    );
  }
  assert.equal(calls, 0);
});

test("an empty list gives an empty result and starts no call", async () => {
  let calls = 0;
  const results = await mapWithLimit<number, number>([], FANOUT_LIMIT, async (item) => {
    calls += 1;
    return item;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});
