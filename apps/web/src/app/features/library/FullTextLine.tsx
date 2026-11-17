import type { FullTextCounts } from "@sciretriever/contracts";

/** The quick filters the numbers lead to (page specs “文献库”). */
export type FullTextFilter = "" | "pdf" | "metadata" | "failed";

/**
 * “全文已取得 n / 总数 m，未取得 k（其中自动途径已试完 j）” for the current
 * scope, counted by paper (query technical 2.1.8). Each number applies its
 * quick filter to the scope; nothing is fetched. Hidden for an empty scope;
 * the parentheses only when j is not 0.
 */
export function FullTextLine({
  counts,
  onPick,
}: {
  counts: FullTextCounts | undefined;
  onPick: (filter: FullTextFilter) => void;
}) {
  if (!counts?.total) return null;
  const link = (n: number, filter: FullTextFilter, name: string) => (
    <button
      type="button"
      className="library-full-text-link"
      aria-label={`${name} ${n.toLocaleString()} 篇`}
      onClick={() => onPick(filter)}
    >
      {n.toLocaleString()}
    </button>
  );
  return (
    <p className="library-full-text" aria-label="全文取得情况">
      全文已取得 {link(counts.obtained, "pdf", "已取得")} / 总数{" "}
      {link(counts.total, "", "总数")}，未取得{" "}
      {link(counts.missing, "metadata", "未取得")}
      {counts.exhausted ? (
        <>（其中自动途径已试完 {link(counts.exhausted, "failed", "已试完")}）</>
      ) : null}
    </p>
  );
}
