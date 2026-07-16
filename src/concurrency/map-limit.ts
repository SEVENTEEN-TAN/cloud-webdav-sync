export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        stopped = true;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) throw firstError;
  return results;
}

export async function mapLimitWeighted<T, R>(
  items: readonly T[],
  limit: number,
  maxWeight: number,
  getWeight: (item: T, index: number) => number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isFinite(maxWeight) || maxWeight < 0) {
    throw new RangeError("maxWeight must be a non-negative finite number");
  }
  const weights = items.map((item, index) => {
    const weight = getWeight(item, index);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`weight at index ${index} must be a non-negative finite number`);
    }
    return weight;
  });
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let activeCount = 0;
  let activeWeight = 0;
  let firstError: unknown;
  let failed = false;

  await new Promise<void>((resolve) => {
    const dispatch = (): void => {
      if (failed) {
        if (activeCount === 0) resolve();
        return;
      }

      while (nextIndex < items.length && activeCount < limit) {
        const index = nextIndex;
        const weight = weights[index] as number;
        if (activeCount > 0 && activeWeight + weight > maxWeight) break;
        nextIndex += 1;
        activeCount += 1;
        activeWeight += weight;

        void Promise.resolve()
          .then(() => task(items[index] as T, index))
          .then((result) => {
            results[index] = result;
          })
          .catch((error: unknown) => {
            if (!failed) firstError = error;
            failed = true;
          })
          .finally(() => {
            activeCount -= 1;
            activeWeight -= weight;
            dispatch();
          });
      }

      if (nextIndex >= items.length && activeCount === 0) resolve();
    };

    dispatch();
  });

  if (failed) throw firstError;
  return results;
}
