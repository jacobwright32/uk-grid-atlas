/**
 * Tiny concurrency limiter. The Elexon fan-outs used to hand every batch to a
 * bare Promise.allSettled, so a cold GB load opened ~30 sockets at once and
 * then 13 more; pooling keeps a handful in flight instead (#9).
 */

/**
 * Run `fn` over `items` with at most `limit` tasks in flight. Results come
 * back in input order and the pool itself never rejects — same settle
 * semantics as the `Promise.allSettled` calls it replaces.
 */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]!, i) }
      } catch (reason) {
        out[i] = { status: 'rejected', reason }
      }
    }
  }
  const workers = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return out
}
