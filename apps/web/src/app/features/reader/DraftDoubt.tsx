import { useQuery } from "@tanstack/react-query";
import type { DraftDifference } from "@sciretriever/contracts";
import { readDraftDifferences } from "../../../reading/transport.js";
import { ErrorNotice } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";

/** One difference: the text layer's words over the draft's (reading-experience 2.5). */
function Difference({ difference }: { difference: DraftDifference }) {
  if (difference.kind === "elsewhere")
    return (
      <p>
        这段文字在本页 PDF 自带的文字里找不到，出现在第{" "}
        {(difference.other_page_index ?? 0) + 1} 页。
      </p>
    );
  const side = (text: string) =>
    text ? <span className="reader-doubt-text">{text}</span> : "（无）";
  return (
    <div className="reader-doubt-pair">
      <p>
        <span className="reader-doubt-label">PDF 自带的文字：</span>
        {side(difference.text_layer)}
      </p>
      <p>
        <span className="reader-doubt-label">未校对的全文：</span>
        {side(difference.parsed)}
      </p>
    </div>
  );
}

/**
 * Reading-experience 2.5: the saved differences of a doubtful draft segment,
 * read from `draft-differences`; nothing is compared again.
 */
export function DraftDoubt({
  segmentId,
  documentVersionId,
}: {
  segmentId: string;
  documentVersionId: string;
}) {
  const api = useApi();
  const differences = useQuery({
    queryKey: ["document", "draft-differences", documentVersionId, segmentId],
    queryFn: ({ signal }) =>
      readDraftDifferences(
        { api, signal, root: document.body, refresh: () => {} },
        documentVersionId,
        segmentId,
      ),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <div className="reader-doubt" aria-busy={differences.isPending}>
      {differences.error ? (
        <ErrorNotice
          message={errorMessage(differences.error)}
          onRetry={() => {
            void differences.refetch();
          }}
        />
      ) : differences.data ? (
        <>
          <strong>疑点 · {differences.data.length} 处差异</strong>
          {differences.data.map((difference, index) => (
            <Difference key={index} difference={difference} />
          ))}
        </>
      ) : (
        <p className="ui-description">正在读取差异…</p>
      )}
    </div>
  );
}
