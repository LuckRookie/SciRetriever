import type { DocumentTranslationSummary } from "@sciretriever/contracts";
import { Button, Icon, SegmentedControl } from "../../../components/index.js";
import {
  fullTextStrings as t,
  translationUnavailable,
} from "../../../strings.js";
import type { ReaderFullText } from "./use-fulltext.js";
import "./translation.css";

/**
 * The PDF view's 对照翻译 (ADR 0051, 0068): it shows the library's stored
 * translation beside each page. Without one the switch is disabled and says
 * why, in the words of the full text's readings (reading-experience 9).
 */
export function FullTextControls({
  fullText,
  summary,
  reason,
}: {
  fullText: ReaderFullText;
  /** The stored translation of the paper's full text; null when it has none. */
  summary: DocumentTranslationSummary | null;
  /** Why there is none, as the full text's readings say it (`translationUnavailable`). */
  reason: string | null;
}) {
  const { mode, progress } = fullText;
  const missing =
    summary?.state === "complete" || summary?.state === "partial"
      ? null
      : (reason ?? translationUnavailable(summary?.state ?? null, "zh-Hans"));
  const status = !progress
    ? summary?.state === "partial" && mode !== "off"
      ? t.pdfPartial
      : null
    : progress.running
      ? t.pdfReading(progress.done, progress.total)
      : progress.failed.length
        ? t.pdfFailed(progress.failed.length)
        : summary?.state === "partial"
          ? t.pdfPartial
          : null;
  return (
    <div className="ft-controls" role="group" aria-label={t.pdfOpen}>
      {mode === "off" ? (
        <>
          <Button
            variant="text"
            icon={<Icon name="translate" />}
            isDisabled={!!missing}
            onPress={() => void fullText.open()}
          >
            {t.pdfOpen}
          </Button>
          {missing ? (
            <p className="ui-description ft-missing">{missing}</p>
          ) : null}
        </>
      ) : (
        <>
          <SegmentedControl
            label={t.pdfMode}
            value={mode}
            onChange={(value) => fullText.setMode(value as "pair" | "only")}
            items={[
              { id: "pair", label: t.pdfPair },
              { id: "only", label: t.pdfOnly },
            ]}
          />
          {status ? (
            <span className="ft-status" role="status" aria-live="polite">
              {status}
            </span>
          ) : null}
          {progress?.running ? (
            <Button variant="text" onPress={fullText.cancel}>
              {t.pdfStop}
            </Button>
          ) : progress?.failed.length ? (
            <Button
              variant="text"
              onPress={() => fullText.retry(progress.failed)}
            >
              {t.pdfRetry}
            </Button>
          ) : null}
          <Button
            variant="text"
            icon={<Icon name="close" />}
            onPress={fullText.close}
          >
            {t.pdfClose}
          </Button>
        </>
      )}
    </div>
  );
}
