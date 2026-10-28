import type {
  MetadataSourceSummary,
  PdfSourceSummary,
  SourceProblem,
  SourceRatio,
} from "@sciretriever/contracts";
import { sourceName } from "../../data/acquisition-wording.js";

const count = new Intl.NumberFormat("zh-CN");
/** A ratio as people read it; a zero denominator is “no sample”, never 0%. */
export function percent(value: SourceRatio | null): string {
  if (!value) return "—";
  if (value.ratio === null) return "无样本";
  if (value.ratio > 0 && value.ratio < 0.01) return "<1%";
  return `${Math.round(value.ratio * 100)}%`;
}
/** Only the three problems a person can act on carry a name; everything else is “错误”. */
export function namedProblems(problems: readonly SourceProblem[]) {
  return [
    ...new Map(
      problems
        .filter((p) => p.display !== "error")
        .map((p) => [p.display, p] as const),
    ).values(),
  ];
}

export interface Bar {
  readonly key: string;
  readonly name: string;
  readonly value: number;
  /** A lighter bar behind the value, such as attempts behind hits. */
  readonly behind?: number;
  readonly text: string;
  readonly tone?: "failed";
}
/** Each paper counts once, under the channel that finally delivered its PDF. */
export function pdfChannelBars(pdf: PdfSourceSummary): Bar[] {
  return [
    ...pdf.sources
      .filter((s) => s.obtained > 0)
      .sort((a, b) => b.obtained - a.obtained)
      .map((s) => ({
        key: s.source,
        name: sourceName(s.source),
        value: s.obtained,
        text: count.format(s.obtained),
      })),
    ...(pdf.not_obtained
      ? [
          {
            key: "not-obtained",
            name: "未获取",
            value: pdf.not_obtained,
            text: count.format(pdf.not_obtained),
            tone: "failed" as const,
          },
        ]
      : []),
  ];
}
/** Attempts are papers that actually reached the source; not enabled and cooling down are not. */
export function pdfAttemptBars(pdf: PdfSourceSummary): Bar[] {
  return pdf.sources
    .filter((s) => s.attempted > 0)
    .map((s) => ({
      key: s.source,
      name: sourceName(s.source),
      value: s.obtained - s.obtained_without_request,
      behind: s.attempted,
      text: `${count.format(s.obtained - s.obtained_without_request)} / ${count.format(s.attempted)}`,
    }));
}
/** One bar per source: what it found that entered this task's merged result. */
export function metadataBars(metadata: MetadataSourceSummary): Bar[] {
  return metadata.sources
    .filter((s) => s.included > 0)
    .sort((a, b) => b.included - a.included)
    .map((s) => ({
      key: s.source,
      name: sourceName(s.source),
      value: s.included,
      text: `${count.format(s.included)} 条 · ${percent(s.coverage)}`,
    }));
}
