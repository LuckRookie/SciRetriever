import { useMutation, useQuery } from "@tanstack/react-query";
import type { TranslationLanguage } from "@sciretriever/contracts";
import { Button, Dialog, TechDetails } from "../../../components/index.js";
import { archiveQuery, archiveWrite } from "../../../data/archive.js";
import { useApi } from "../../../data/query.js";
import { record } from "../../../data/wire.js";
import { errorMessage } from "../../../strings.js";
import { languageName } from "../input/translation-language.js";

const refusals: Readonly<Record<string, string>> = {
  "translation-needs-proofread":
    "这一篇还没有校对过的全文，先解析全文才能翻译。",
  "archive-busy": "这一篇正在解析全文，完成后再翻译。",
};
const numbers = (range: unknown) =>
  range && typeof range === "object" && "median" in range && "p90" in range
    ? [range.median, range.p90]
        .map((n) => Number(n).toLocaleString())
        .filter((n, i, all) => i === 0 || n !== all[0])
        .join("–")
    : null;

/**
 * Translates one paper into a language on request (ADR 0072): the same kind
 * of confirmation as 解析全文, with the model's expected use, then a task.
 */
export function TranslateDialog({
  literatureId,
  language,
  onClose,
  onStarted,
}: {
  literatureId: string;
  language: TranslationLanguage;
  onClose: () => void;
  onStarted: (outcome: "queued" | "skipped") => void;
}) {
  const api = useApi(),
    name = languageName(language),
    request = { literature_id: literatureId, target_language: language };
  const estimate = useQuery({
    queryKey: ["translate-estimate", literatureId, language],
    retry: false,
    queryFn: async ({ signal }) =>
      record(
        await archiveQuery(
          api,
          "usage-estimate",
          { kind: "document-translate", request },
          signal,
        ),
        "estimate",
      ),
  });
  const refusal =
    typeof estimate.data?.refusal === "string"
      ? (refusals[estimate.data.refusal] ?? "这一篇现在不能翻译。")
      : null;
  const total =
    estimate.data && typeof estimate.data.total === "object"
      ? (estimate.data.total as Record<string, unknown>)
      : null;
  const skipped =
    estimate.data?.state === "complete" ||
    estimate.data?.state === "same-language";
  const start = useMutation({
    mutationFn: async () =>
      record(await archiveWrite(api, "document-translate", request), "result"),
    onSuccess: (result) =>
      onStarted(result.outcome === "skipped" ? "skipped" : "queued"),
  });
  return (
    <Dialog
      title={`把这一篇翻译成${name}`}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" onPress={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            isDisabled={!!refusal || skipped || estimate.isPending}
            isPending={start.isPending}
            onPress={() => start.mutate()}
          >
            {`翻译成${name}`}
          </Button>
        </>
      }
    >
      <p>
        只翻译这一篇的全文，不重做别的步骤；会调用模型。翻好后“译”就读{name}。
      </p>
      {refusal ? <p className="ui-description">{refusal}</p> : null}
      {skipped ? (
        <p className="ui-description">{`这一篇已经有${name}译文。`}</p>
      ) : null}
      {start.error ? (
        <p className="ui-description" role="alert">
          {errorMessage(start.error)}
        </p>
      ) : null}
      {estimate.data && !refusal && !skipped ? (
        <TechDetails title="技术详情：预计用量">
          <p>
            {[
              numbers(total?.calls) && `模型调用 ${numbers(total?.calls)} 次`,
              numbers(total?.input_tokens) &&
                `输入约 ${numbers(total?.input_tokens)} token`,
              numbers(total?.output_tokens) &&
                `输出约 ${numbers(total?.output_tokens)} token`,
            ]
              .filter(Boolean)
              .join(" · ") || "还没有同样的历史，执行时再核算。"}
          </p>
        </TechDetails>
      ) : null}
    </Dialog>
  );
}
