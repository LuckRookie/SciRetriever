import type { SourceCandidate } from "./locators.js";
export interface RouteResult {
  readonly delivered: readonly SourceCandidate[];
  readonly misses: readonly string[];
  readonly failures: readonly string[];
  readonly exhausted: boolean;
}
export async function routeCandidates(
  sources: readonly (() => Promise<SourceCandidate | null>)[],
): Promise<RouteResult> {
  const delivered: SourceCandidate[] = [];
  const misses: string[] = [];
  const failures: string[] = [];
  for (const load of sources) {
    try {
      const result = await load();
      if (result) delivered.push(result);
      else misses.push("normal-miss");
    } catch {
      failures.push("route-failure");
    }
  }
  return Object.freeze({
    delivered: Object.freeze(delivered),
    misses: Object.freeze(misses),
    failures: Object.freeze(failures),
    exhausted: failures.length === 0 && delivered.length === 0,
  });
}
