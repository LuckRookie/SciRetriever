import { markdown } from "../../../reading/markdown.js";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  processorJson,
  type EvidenceRef,
  type ProcessorCitation,
} from "@sciretriever/contracts";
import {
  Button,
  ErrorNotice,
  Skeleton,
  TechDetails,
  Tooltip,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import {
  readProcessorResult,
  resolveProcessorEvidence,
} from "../../data/processor-results.js";
import { sourceParameters } from "../../data/sources.js";
import { useShell } from "../../shell/context.js";
import { processingError } from "./form.js";
import { display } from "./result-shape.js";
import {
  readEvidencePage,
  nextEvidencePage,
  type EvidencePageCursor,
} from "../../../reading/transport.js";

/** Resolves a citation to its value, original passages and upstream links; shared by the drawer and the hover preview. */
function evidenceQuery(
  api: ReturnType<typeof useApi>,
  citation: ProcessorCitation,
) {
  return {
    queryKey: ["processors", "evidence", citation],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const upstream: ProcessorCitation[] = [];
      let missing = "";
      if (citation.kind === "document")
        return {
          value: null,
          evidence: [citation.evidence],
          upstream,
          missing,
          sourceOnly: false,
        };
      const resolved = await resolveProcessorEvidence(api, citation, signal);
      if (citation.kind === "result") {
        const saved = await readProcessorResult(api, citation, signal),
          content = saved.result.content;
        if (content.kind === "records") {
          const row = content.records.find(
            (item) => item.record_id === citation.record_id,
          );
          if (!row) throw new Error("固定原记录不存在。");
          upstream.push(
            ...row.evidence
              .filter(
                (item) =>
                  !citation.pointer ||
                  !item.pointer ||
                  citation.pointer === item.pointer ||
                  citation.pointer.startsWith(`${item.pointer}/`),
              )
              .flatMap((item) => item.sources)
              .filter((item) => item.kind !== "document"),
          );
          missing =
            row.missing[citation.pointer] ??
            row.missing[citation.pointer.slice(1)] ??
            "";
        } else if (content.kind === "report")
          upstream.push(
            ...(
              content.claims.find((c) => c.record_id === citation.record_id)
                ?.sources ?? []
            ).filter((item) => item.kind !== "document"),
          );
      }
      return { ...resolved, upstream, missing, sourceOnly: false };
    },
  };
}
/** First page of one original passage; the drawer reads further pages with the same key. */
function passageQuery(api: ReturnType<typeof useApi>, evidence: EvidenceRef) {
  return {
    queryKey: ["document", "result-passage", evidence],
    initialPageParam: {
      continuation: null,
      expectedStart: null,
    } as EvidencePageCursor,
    retry: false,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: EvidencePageCursor;
      signal: AbortSignal;
    }) =>
      readEvidencePage(
        { api, signal, root: document.body, refresh: () => {} },
        evidence,
        pageParam,
      ),
    getNextPageParam: nextEvidencePage,
  };
}
export function ResultEvidence({
  citation,
  onFollow,
  returnParameters,
}: {
  citation: ProcessorCitation;
  onFollow: (next: ProcessorCitation) => void;
  returnParameters: Record<string, string>;
}) {
  const api = useApi();
  const data = useQuery(evidenceQuery(api, citation));
  if (data.isPending) return <Skeleton label="正在核验固定来源" />;
  if (data.isError)
    return (
      <ErrorNotice
        message={processingError(data.error)}
        retained="固定来源未被替换。"
        onRetry={() => data.refetch().then(() => {})}
      />
    );
  return (
    <>
      {citation.kind !== "document" ? (
        <p>
          {data.data.value == null
            ? "无法判断 / 未报告。空值不表示否或零。"
            : typeof data.data.value === "string"
              ? data.data.value
              : display(processorJson(data.data.value, 8 * 1024 * 1024))}
        </p>
      ) : null}
      {data.data.sourceOnly ? (
        <p className="ui-description">仅已存来源可核对，原 PDF 未复核。</p>
      ) : null}
      {data.data.missing ? (
        <p className="ui-description">{data.data.missing}</p>
      ) : null}
      {data.data.upstream.map((source, index) => (
        <Button key={index} variant="text" onPress={() => onFollow(source)}>
          核对{source.kind === "result" ? "上游记录" : "知识断言"} {index + 1}
        </Button>
      ))}
      {data.data.evidence.length ? (
        data.data.evidence.map((evidence, index) => (
          <Passage
            key={JSON.stringify(evidence)}
            evidence={evidence}
            index={index}
            returnParameters={returnParameters}
          />
        ))
      ) : (
        <p>该字段没有可定位的原文依据，不能从缺少证据推断否定结论。</p>
      )}
      <TechDetails copyText={JSON.stringify(citation, null, 2)}>
        <pre>{JSON.stringify(citation, null, 2)}</pre>
      </TechDetails>
    </>
  );
}
function Passage({
  evidence,
  index,
  returnParameters,
}: {
  evidence: EvidenceRef;
  index: number;
  returnParameters: Record<string, string>;
}) {
  const api = useApi(),
    shell = useShell();
  const data = useInfiniteQuery(passageQuery(api, evidence));
  const first = data.data?.pages[0];
  return (
    <section className="result-passage">
      <h3>原文证据 {index + 1}</h3>
      {first?.location && first.document ? (
        <Button
          onPress={() => {
            const m = first.document!.source_material_ref;
            shell.openPaper(m.literature_id, "pdf", {
              ...returnParameters,
              asset: m.asset_id,
              assetHash: m.asset_sha256,
              page: String(first.location!.page),
              ...(first.location!.region
                ? { region: JSON.stringify(first.location!.region) }
                : {}),
            });
          }}
        >
          在 PDF 中核对区域
        </Button>
      ) : null}
      {data.isPending ? <Skeleton rows={1} /> : null}
      {data.isError ? (
        <ErrorNotice
          message={processingError(data.error)}
          retained="已读取证据保留；固定来源没有替换。"
          onRetry={() =>
            (data.hasNextPage ? data.fetchNextPage() : data.refetch()).then(
              () => {},
            )
          }
        />
      ) : null}
      {first?.granularity === "file" ? (
        <>
          <p>证据指向原始文件，没有正文片段定位。</p>
          {first.material ? (
            <Button
              onPress={() =>
                shell.openPaper(first.material!.literature_id, "pdf", {
                  ...returnParameters,
                  from: returnParameters.from ?? "ext",
                  asset: first.material!.asset_id,
                  assetHash: first.material!.asset_sha256,
                })
              }
            >
              打开固定原始 PDF
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <blockquote
            className="reader-prose"
            dangerouslySetInnerHTML={{
              __html: markdown.parse(
                data.data?.pages.map((page) => page.text ?? "").join("") ?? "",
              ),
            }}
          />
          {first ? (
            <p className="ui-description">
              {data.hasNextPage ? "已读取部分证据。" : "已读取完整证据。"}
            </p>
          ) : null}
          {data.hasNextPage ? (
            <Button
              isPending={data.isFetchingNextPage}
              onPress={() => data.fetchNextPage().then(() => {})}
            >
              继续读取证据
            </Button>
          ) : null}
          {first?.document && first.target_range ? (
            <Button
              onPress={() => {
                const document = first.document!,
                  material = document.source_material_ref;
                shell.openPaper(material.literature_id, "doc", {
                  ...returnParameters,
                  from: returnParameters.from ?? "ext",
                  ...sourceParameters({
                    kind: "document",
                    literature_id: material.literature_id,
                    asset_id: material.asset_id,
                    asset_sha256: material.asset_sha256,
                    document_version_id: document.document_version_id,
                    representation_sha256: document.representation_sha256,
                    ...first.target_range!,
                  }),
                });
              }}
            >
              打开这段原文
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Hover or keyboard focus on a cited value previews its first original passage;
 * pressing still opens the full evidence drawer.
 */
export function EvidencePeek({
  citation,
  children,
}: {
  citation: ProcessorCitation;
  children: ReactNode;
}) {
  return (
    <Tooltip wide text={<PeekBody citation={citation} />}>
      {children}
    </Tooltip>
  );
}
function PeekBody({ citation }: { citation: ProcessorCitation }) {
  const api = useApi();
  const data = useQuery(evidenceQuery(api, citation));
  const first = data.data?.evidence[0];
  if (data.isPending)
    return <p className="evidence-peek-note">正在读取原文…</p>;
  if (data.isError)
    return <p className="evidence-peek-note">{processingError(data.error)}</p>;
  if (!first)
    return (
      <p className="evidence-peek-note">
        {data.data.missing || "该字段没有可定位的原文依据。"}
      </p>
    );
  return <PeekPassage evidence={first} count={data.data.evidence.length} />;
}
function PeekPassage({
  evidence,
  count,
}: {
  evidence: EvidenceRef;
  count: number;
}) {
  const api = useApi();
  const data = useInfiniteQuery(passageQuery(api, evidence));
  const page = data.data?.pages[0];
  // The peek is a clamped single paragraph: flatten headings and breaks, keep math.
  const text = (page?.text ?? "")
    .replace(/^#+\s*/gm, "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `$${tex.trim()}$`)
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return (
    <div className="evidence-peek">
      {data.isPending ? (
        <p className="evidence-peek-note">正在读取原文…</p>
      ) : data.isError ? (
        <p className="evidence-peek-note">{processingError(data.error)}</p>
      ) : page?.granularity === "file" ? (
        <p className="evidence-peek-note">
          证据指向原始文件，没有正文片段定位。
        </p>
      ) : text ? (
        <blockquote
          dangerouslySetInnerHTML={{
            __html: markdown.parseInline(text, { async: false }),
          }}
        />
      ) : (
        <blockquote>原文片段为空。</blockquote>
      )}
      <p className="evidence-peek-note">
        {page?.location ? `PDF 第 ${page.location.page} 页 · ` : ""}
        {count > 1 ? `共 ${count} 处原文，` : ""}点击查看完整证据与核对
      </p>
    </div>
  );
}
