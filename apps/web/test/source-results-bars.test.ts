import { expect, it } from "vitest";
import { parseTaskSourceResults } from "@sciretriever/contracts";
import { SourceResultAggregation } from "../../server/src/application/source-results.js";
import {
  metadataBars,
  pdfAttemptBars,
  pdfChannelBars,
  percent,
} from "../src/app/features/tasks/source-bars.js";

const at = "2026-10-28T00:00:00.000Z";
const paper = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stage = (source: string) =>
  source === "browser"
    ? "browser"
    : source === "sci-hub"
      ? "public-web"
      : "publisher-api";

/** Per-paper events go through the production reducer; the bars must add up to them. */
function pdfTask(
  plans: readonly [tries: string[][], channel: string | null][],
) {
  const t = new SourceResultAggregation();
  plans.forEach(([tries, channel], n) => {
    for (const [source, result] of tries)
      t.accept({
        job_id: "job",
        kind: "acquisition-attempt",
        payload: {
          target_id: `t${n}`,
          literature_id: paper(n),
          attempt: {
            source,
            stage: stage(source!),
            started_at: at,
            finished_at: at,
            result,
            requested: !["escalated", "cooldown", "not-enabled"].includes(
              result!,
            ),
          },
        },
      });
    t.accept({
      job_id: "job",
      kind: "pdf-source-result",
      payload: {
        target_id: `t${n}`,
        result: {
          schema_version: 1,
          literature_id: paper(n),
          finished_at: at,
          result: channel ? "obtained" : "not-obtained",
          source: channel,
          stage: channel ? stage(channel) : null,
          receipt_id: channel ? `r${n}` : null,
          technical_details: { diagnostics: [] },
        },
      },
    });
  });
  return parseTaskSourceResults(t.task()).pdf!;
}

it("counts each paper once, under its final channel, and never counts skipped sources as attempts", () => {
  const pdf = pdfTask([
    [[["elsevier", "hit"]], "elsevier"],
    [
      [
        ["elsevier", "miss"],
        ["wiley", "hit"],
      ],
      "wiley",
    ],
    [
      [
        ["elsevier", "miss"],
        ["wiley", "cooldown"],
        ["browser", "escalated"],
        ["browser", "hit"],
      ],
      "browser",
    ],
    [
      [
        ["elsevier", "not-enabled"],
        ["sci-hub", "miss"],
      ],
      null,
    ],
  ]);
  const channels = pdfChannelBars(pdf);
  // Every paper sits in exactly one bar: its delivering channel or “未获取”.
  expect(channels.reduce((n, b) => n + b.value, 0)).toBe(4);
  expect(channels.map((b) => [b.name, b.value])).toEqual([
    ["Elsevier API", 1],
    ["Wiley API", 1],
    ["Browser Agent", 1],
    ["未获取", 1],
  ]);
  const attempts = Object.fromEntries(
    pdfAttemptBars(pdf).map((b) => [b.key, [b.value, b.behind]]),
  );
  // Elsevier was not enabled for the fourth paper; Wiley was cooling down for the third.
  expect(attempts).toEqual({
    elsevier: [1, 3],
    wiley: [1, 1],
    browser: [1, 1],
    "sci-hub": [0, 1],
  });
});

it("draws a metadata bar per source from what entered the merged result, with its coverage", () => {
  const t = new SourceResultAggregation();
  const emit = (record: string, source: string, phase: string, extra = {}) =>
    t.accept({
      job_id: "job",
      kind: "metadata-source",
      payload: {
        target_id: "topic",
        progress: {
          schema_version: 1,
          record_id: record,
          source,
          purpose: "topic-search",
          role: "primary",
          unit_id: "topic",
          at,
          phase,
          ...extra,
        },
      },
    });
  for (const [source, ids] of [
    ["openalex", [1, 2, 3]],
    ["crossref", [3, 4]],
  ] as const) {
    emit(source, source, "started");
    emit(source, source, "requested");
    emit(source, source, "returned", { count: ids.length + 1 });
    for (const id of ids) {
      emit(source, source, "observed", {
        result_id: paper(id),
        disposition: "created",
      });
      emit(source, source, "included", {
        result_id: paper(id),
        disposition: "related",
      });
    }
    emit(source, source, "finished", { result: "hit", problem: null });
  }
  emit("core", "core", "started");
  emit("core", "core", "requested");
  emit("core", "core", "finished", { result: "miss", problem: null });
  const metadata = parseTaskSourceResults(t.task()).metadata!;
  expect(metadata.merged).toBe(4);
  expect(metadataBars(metadata).map((b) => [b.key, b.value, b.text])).toEqual([
    ["openalex", 3, "3 条 · 75%"],
    ["crossref", 2, "2 条 · 50%"],
  ]);
});

it("reads a zero denominator as no sample, never as 0%", () => {
  expect(percent({ numerator: 0, denominator: 0, ratio: null })).toBe("无样本");
  expect(percent({ numerator: 1, denominator: 400, ratio: 0.0025 })).toBe(
    "<1%",
  );
  expect(percent(null)).toBe("—");
});
