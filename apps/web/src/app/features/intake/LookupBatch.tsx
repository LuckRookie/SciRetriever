import type { ReactNode } from "react";
import type { IntakeLookupSummary } from "@sciretriever/contracts";
import {
  Button,
  DataTable,
  Definition,
  Definitions,
  Menu,
} from "../../components/index.js";
import {
  candidateText,
  DISPOSITIONS,
  type BatchItemResult,
  type BatchSummary,
} from "../../data/imports.js";
import type { LookupItem, LookupParts } from "../../data/intake-lookup.js";
import { lookupReason } from "../../strings.js";
import { Counts } from "./batch-parts.js";

/** A `lookup` batch's line counts (literature materials 6.4.10), zeros left out. */
const lineItems = (l: IntakeLookupSummary) =>
  [
    ["行数", l.lines],
    ["认出", l.recognized],
    ["已在库", l.existing],
    ["可能是这一篇", l.candidates],
    ["没认出", l.unrecognized],
    ["其中仍然入库", l.included],
    ["无法处理", l.rejected],
    ["重复的行", l.duplicates],
    ["待识别", l.pending],
  ] as const;

/** Counts of a `lookup` batch: its lines, and once confirmed what went in. */
export function LookupCounts({
  summary,
  records,
}: {
  summary: BatchSummary;
  records: readonly (readonly [string, number])[] | null;
}) {
  return (
    <Definitions>
      <Definition term="各行">
        {summary.lookup ? (
          <Counts items={lineItems(summary.lookup)} label="各行计数" />
        ) : (
          <span className="ui-description">没有行数。</span>
        )}
      </Definition>
      {records ? (
        <Definition term="书目">
          <Counts items={records} keepZero label="书目计数" />
        </Definition>
      ) : null}
    </Definitions>
  );
}

/** “标题 · 第一作者 · 年份” of what a line was recognized as. */
function foundText(item: LookupItem) {
  const found = item.lookup.found;
  return found ? candidateText(found) : (item.title ?? "");
}
function LineText({ item }: { item: LookupItem }) {
  return (
    <span className="intake-lookup-text">
      <span
        className="intake-lookup-no"
        aria-label={`第 ${item.lookup.line} 行`}
      >
        {item.lookup.line}
      </span>
      <span className="intake-lookup-given">{item.lookup.text}</span>
    </span>
  );
}

/** Why an unrecognized line was not recognized, in the reader's words. */
const unrecognizedWhy = (item: LookupItem) =>
  item.recognition?.state === "cancelled"
    ? "识别停止时还没有查这一行"
    : "文献来源里没有找到这一篇";

function candidateChosen(item: LookupItem) {
  const d = item.decision;
  if (d?.kind === "candidate") {
    const chosen = item.recognition?.candidates.find(
      (c) => c.candidate_id === d.candidate_id,
    );
    // Candidates may share a title; the author and year tell them apart.
    return `采用：${chosen ? candidateText(chosen) : "所选的一项"}`;
  }
  return d?.kind === "unrecognized" ? "都不是" : "待决定";
}

/**
 * “需要决定” for a `lookup` batch: lines with possible works (adopt one, or
 * none), and lines not recognized (left out unless added as given). The
 * decision stands at the row's end and can change until confirmation.
 */
export function LookupDecisions({
  parts,
  decide,
  disabled,
  error,
}: {
  parts: LookupParts;
  decide: (item: LookupItem, decision: unknown) => void;
  disabled: boolean;
  error: ReactNode;
}) {
  const count = parts.candidates.length + parts.unrecognized.length;
  if (!count) return null;
  return (
    <section className="intake-batch-part" aria-labelledby="batch-decide">
      <h3 id="batch-decide">需要决定（{count}）</h3>
      {error}
      {parts.candidates.length ? (
        <div
          className="intake-decision-group"
          role="group"
          aria-label="可能是这一篇"
        >
          <h4>可能是这一篇（{parts.candidates.length}）</h4>
          <ul>
            {parts.candidates.map((item) => (
              <li key={item.item_id} className="intake-decision">
                <span className="intake-decision-name">
                  <LineText item={item} />
                </span>
                <span className="intake-decision-actions">
                  <Menu
                    label="采用"
                    indicator
                    items={(item.recognition?.candidates ?? [])
                      .slice(0, 3)
                      .map((c) => ({
                        id: c.candidate_id,
                        label: candidateText(c),
                        disabled,
                        onAction: () =>
                          decide(item, {
                            kind: "candidate",
                            candidate_id: c.candidate_id,
                          }),
                      }))}
                  />
                  <Button
                    size="compact"
                    isDisabled={disabled}
                    onPress={() => decide(item, { kind: "unrecognized" })}
                  >
                    都不是
                  </Button>
                </span>
                <span className="intake-decision-chosen">
                  {candidateChosen(item)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {parts.unrecognized.length ? (
        <div className="intake-decision-group" role="group" aria-label="没认出">
          <h4>没认出（{parts.unrecognized.length}）</h4>
          <ul>
            {parts.unrecognized.map((item) => (
              <li key={item.item_id} className="intake-decision">
                <span className="intake-decision-name">
                  <LineText item={item} />
                  <span className="intake-lookup-why">
                    {unrecognizedWhy(item)}
                  </span>
                </span>
                <span className="intake-decision-actions">
                  <Button
                    size="compact"
                    isDisabled={disabled}
                    onPress={() => decide(item, { kind: "include" })}
                  >
                    仍然入库
                  </Button>
                  <Button
                    size="compact"
                    isDisabled={disabled}
                    onPress={() => decide(item, { kind: "exclude" })}
                  >
                    不入库
                  </Button>
                </span>
                <span className="intake-decision-chosen">
                  {item.lookup.included ? "仍然入库" : "不入库"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function LinePart({
  id,
  title,
  items,
  side,
  literature = false,
}: {
  id: string;
  title: string;
  items: readonly LookupItem[];
  side?: (item: LookupItem) => string;
  /** The side names a work, set as literature; otherwise it is a note. */
  literature?: boolean;
}) {
  if (!items.length) return null;
  return (
    <section className="intake-batch-part" aria-labelledby={id}>
      <h3 id={id}>
        {title}（{items.length}）
      </h3>
      <ul className="intake-lookup-list">
        {items.map((item) => (
          <li key={item.item_id} className="intake-lookup-item">
            <LineText item={item} />
            {side ? (
              <span
                className="intake-lookup-side"
                data-literature={literature || undefined}
              >
                {side(item)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The lines that need nothing from the reader: recognized, already in the
 * library, not looked up yet, and what will not be imported.
 */
export function LookupLines({ parts }: { parts: LookupParts }) {
  return (
    <>
      <LinePart
        id="lookup-recognized"
        title="认出的"
        items={parts.recognized}
        side={foundText}
        literature
      />
      <LinePart
        id="lookup-existing"
        title="已在库的"
        items={parts.existing}
        side={foundText}
        literature
      />
      <LinePart id="lookup-pending" title="等待识别" items={parts.pending} />
      <LinePart
        id="lookup-refused"
        title="没有导入的内容"
        items={parts.refused}
        side={(item) =>
          lookupReason(
            item.lookup.outcome === "duplicate"
              ? "duplicate-line"
              : (item.lookup.reason ?? ""),
          )
        }
      />
    </>
  );
}

const ADMITTED = new Set(["created", "enriched", "matched", "restored"]);
/** The report's lines that did not go in, each with its line, text and reason. */
export function LookupReport({ items }: { items: readonly BatchItemResult[] }) {
  const left = items
    .filter((item) => !ADMITTED.has(item.disposition))
    .sort((a, b) => (a.line?.number ?? 0) - (b.line?.number ?? 0));
  if (!left.length) return null;
  return (
    <DataTable
      label="没有入库的行"
      rows={left}
      getRowId={(item) => `${item.sequence}:${item.record_index}`}
      columns={[
        {
          id: "line",
          header: "行",
          value: (item) => String(item.line?.number ?? item.record_index + 1),
        },
        {
          id: "text",
          header: "原文",
          value: (item) => item.line?.text || item.external_id || "—",
        },
        {
          id: "result",
          header: "结果",
          value: (item) => DISPOSITIONS[item.disposition],
        },
        {
          id: "reason",
          header: "原因",
          value: (item) => (item.reason ? lookupReason(item.reason) : "—"),
        },
      ]}
    />
  );
}
