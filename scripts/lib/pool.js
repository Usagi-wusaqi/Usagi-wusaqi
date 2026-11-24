/**
 * 并发原语：有界并发的 map / each，不关心具体任务。
 */

/** 并发执行，结果按原顺序返回。 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(Math.min(limit, items.length), 1);
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 并发执行，谁先完成谁先处理收尾动作。 */
export async function eachPool(items, limit, fn) {
  let next = 0;
  const size = Math.max(Math.min(limit, items.length), 1);
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      await fn(items[index], index);
    }
  });
  await Promise.all(runners);
}
