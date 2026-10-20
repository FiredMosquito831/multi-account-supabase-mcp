// The most accounts a fan-out calls at the same time.
export const FANOUT_LIMIT = 4;

// Calls fn for each item, with at most limit calls in flight. The results are in the order of the items,
// not the order in which the calls finish. After a call fails, no later item starts, and the result rejects
// with that error. Calls that already started run to their end.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`The fan-out limit must be a whole number of at least 1, not ${limit}.`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  // Each worker takes the next item once its own call has finished, so a worker has one call in flight at most.
  const worker = async (): Promise<void> => {
    while (!stopped && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
