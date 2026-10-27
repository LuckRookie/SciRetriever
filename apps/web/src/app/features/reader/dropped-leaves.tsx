import type { ApiClient } from "../../data/api.js";
import { archiveJsonStream } from "../../data/archive.js";
import { record } from "../../data/wire.js";
import { Button } from "../../components/index.js";
import { dropReasons } from "../../strings.js";

export interface DroppedLeaf {
  leafId: string;
  page: number;
  reason: string;
  text: string;
  /** Where restoring puts it: the section of the nearest kept neighbour in source order. */
  target: Record<string, unknown>;
}

/** Reads every leaf once so a restored leaf can join its neighbour's section. */
export async function readDroppedLeaves(
  api: ApiClient,
  asset: string,
  proofread: string,
  signal?: AbortSignal,
): Promise<DroppedLeaf[]> {
  const { value } = await archiveJsonStream(
    api,
    "archive-arrangement",
    {
      schema_version: 2,
      asset_id: asset,
      proofread_id: proofread,
      kind: "leaves",
      visibility: "all",
      drop_reason: null,
      page_index: null,
      limit: 200,
      max_bytes: 65536,
    },
    "cursor",
    signal,
  );
  if (!Array.isArray(value)) throw new Error("整理数据回执无效");
  const leaves = value.map((v) => {
    const row = record(v, "leaf row"),
      leaf = record(row.leaf, "leaf"),
      destination = record(row.destination, "destination");
    return {
      leafId: String(leaf.leaf_id),
      page: Number(leaf.page_index),
      text: String(leaf.original_text),
      destination,
    };
  });
  const kept = (from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < leaves.length; i += step)
      if (leaves[i]!.destination.kind === "assigned")
        return record(leaves[i]!.destination.target, "target");
    return null;
  };
  return leaves.flatMap((l, i) =>
    l.destination.kind === "dropped"
      ? [
          {
            leafId: l.leafId,
            page: l.page,
            reason: String(l.destination.reason),
            text: l.text,
            target: kept(i - 1, -1) ??
              kept(i + 1, 1) ?? {
                role: "additional",
                original_heading_leaf_id: null,
              },
          },
        ]
      : [],
  );
}

/** Left-out text of one page, each with why it was dropped and a way back. */
export function DroppedLeaves({
  leaves,
  disabled,
  onRestore,
}: {
  leaves: readonly DroppedLeaf[];
  disabled: string | null;
  onRestore: (leaf: DroppedLeaf) => void;
}) {
  if (!leaves.length) return null;
  return (
    <ul className="dropped-leaves" aria-label="本页已删除的内容">
      {leaves.map((leaf) => (
        <li key={leaf.leafId} className="dropped-leaf">
          <div>
            <p className="dropped-leaf-reason">
              已删除 · {dropReasons[leaf.reason] ?? "其他"}
            </p>
            <p className="dropped-leaf-text">
              {leaf.text.length > 600
                ? `${leaf.text.slice(0, 600)}…`
                : leaf.text || "（空白区块）"}
            </p>
          </div>
          <Button
            size="compact"
            variant="text"
            isDisabled={disabled !== null}
            onPress={() => onRestore(leaf)}
          >
            恢复
          </Button>
        </li>
      ))}
    </ul>
  );
}
