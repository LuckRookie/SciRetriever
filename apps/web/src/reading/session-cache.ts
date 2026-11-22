/**
 * Session memory (reading-experience 5.1): one bounded map, least recently
 * used first. Returns the bytes in use after adding `value`.
 */
export function remember<V>(
  cache: Map<string, { value: V; size: number }>,
  key: string,
  value: V,
  size: number,
  limit: number,
  used: number,
): number {
  if (size > limit) return used;
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    used -= previous.size;
  }
  cache.set(key, { value, size });
  used += size;
  for (const [old, entry] of cache) {
    if (used <= limit) break;
    cache.delete(old);
    used -= entry.size;
  }
  return used;
}
