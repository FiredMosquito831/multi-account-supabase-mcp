// The most accounts a fan-out calls at the same time.
export const FANOUT_LIMIT = 4;

// Calls fn for each item, with at most limit calls in flight. Every item runs, even after a call fails, so one
// failure does not hide the others. The results are in the order of the items, not the order in which the calls
// finish. When a call fails, the returned promise rejects with the first error recorded, and only after every call
// has settled, so no call is still running when it rejects.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`The fan-out limit must be a whole number of at least 1, not ${limit}.`);
  }
  const results = new Array<R>(items.length);
  // The errors are in the order they happened, so errors[0] is the first one recorded.
  const errors: unknown[] = [];
  let next = 0;
  // A worker takes the next item once its own call has settled, so a worker has one call in flight at most.
  // A failed call is recorded and the worker goes on, so every item runs. The worker never rejects.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (errors.length > 0) {
    throw errors[0];
  }
  return results;
}
