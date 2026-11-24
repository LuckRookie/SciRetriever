import type { ReactNode } from "react";
import { PageHeader, Tabs } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import "./processing.css";

/**
 * The tabs of “加工” (page specs “整体信息架构”): what is made from the
 * papers and what it is made with. Each is its own `view`, so the old
 * addresses open their tab and every switch is a history entry.
 */
export const PROCESSING_TABS = [
  { id: "ext", label: "算子" },
  { id: "snapshots", label: "快照" },
  { id: "tags", label: "标签词表" },
  { id: "ins", label: "洞察" },
] as const;
export type ProcessingTab = (typeof PROCESSING_TABS)[number]["id"];
export const processingTabs: readonly string[] = PROCESSING_TABS.map(
  (tab) => tab.id,
);
/**
 * Leaves whatever was drilled into (one result, one snapshot, one tag): the
 * entrance and every tab open the tab's own top level.
 */
export const PROCESSING_TOP = {
  literature: null,
  result: null,
  resultHash: null,
  collection: null,
  snapshot: null,
  processor: null,
  scope: null,
  results: null,
  tab: null,
  tools: null,
  tag: null,
  rerun: null,
  rerunHash: null,
} as const;
/** The query entrance reads results and insights; the rest need the workspace. */
const READ_ONLY: readonly string[] = ["ext", "ins"];

/**
 * “加工” and its four tabs, the same on each of them; the tab's own action
 * sits at the header's right. A page drilled into (one snapshot, one result)
 * keeps its own header instead.
 */
export function ProcessingHeader({
  tab,
  action,
}: {
  tab: ProcessingTab;
  /** The tab's own action, such as “运行算子”. */
  action?: ReactNode;
}) {
  const api = useApi();
  return (
    <>
      <PageHeader title="加工" action={action} />
      <div className="processing-tabs">
        <Tabs
          label="加工视图"
          value={tab}
          onChange={(next) =>
            navigate({ view: next, ...PROCESSING_TOP }, { clearSource: true })
          }
          items={PROCESSING_TABS.filter(
            (item) => api.kind === "workspace" || READ_ONLY.includes(item.id),
          )}
        />
      </div>
    </>
  );
}
