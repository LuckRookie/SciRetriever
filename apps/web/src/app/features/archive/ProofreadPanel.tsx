import { markdown } from "../../../reading/markdown.js";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { parsePageRegion } from "@sciretriever/contracts";
import {
  Button,
  Disclosure,
  ErrorNotice,
  Skeleton,
  TextArea,
} from "../../components/index.js";
import {
  archiveQuery,
  archiveWrite,
  rows,
  useArchiveAction,
} from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { navigate } from "../../data/url.js";
import { archiveStrings, errorMessage } from "../../strings.js";
import { RegionToggle } from "./RegionPreview.js";
const suspectLabels: Record<string, string> = {
  missing: "可能遗漏",
  extra: "可能多出",
  "token-mismatch": "数字、单位或化学式差异",
  "page-misplaced": "页归属待核对",
};
export function ProofreadPanel({
  id,
  asset,
  hash,
  segment,
}: {
  id: string;
  asset: string;
  hash: string;
  segment?: string;
}) {
  const api = useApi(),
    action = useArchiveAction(),
    [edited, setEdited] = useState<Record<string, string>>({}),
    [reasons, setReasons] = useState<Record<string, string>>({}),
    [failure, setFailure] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["document", "proofread-inspect", asset, segment],
    initialPageParam: { blocks: 0, pages: 0 },
    queryFn: async ({ signal, pageParam }) =>
      record(
        await archiveQuery(
          api,
          "proofread-inspect",
          {
            asset_id: asset,
            offset: pageParam.blocks,
            page_offset: pageParam.pages,
            page_limit: 20,
            limit: 20,
            unresolved_only: false,
            ...(segment ? { block_id: segment } : {}),
          },
          signal,
        ),
        "proofreading",
      ),
    getNextPageParam: (p) =>
      typeof p.next_offset === "number" ||
      typeof p.next_page_offset === "number"
        ? {
            blocks:
              typeof p.next_offset === "number"
                ? p.next_offset
                : Number(p.total_count),
            pages:
              typeof p.next_page_offset === "number"
                ? p.next_page_offset
                : Number(p.page_count),
          }
        : undefined,
  });
  if (query.isPending) return <Skeleton label="正在读取校订记录" />;
  if (query.error)
    return (
      <ErrorNotice
        message={errorMessage(query.error)}
        onRetry={() => query.refetch().then(() => {})}
      />
    );
  const first = query.data!.pages[0]!,
    current = first.current ? record(first.current, "proofread version") : null;
  const decide = async (
    item: Record<string, unknown>,
    operation: string,
    suspect?: Record<string, unknown>,
    status?: string,
    decisionId?: string,
  ) => {
    setFailure("");
    const key = String(item.block_id);
    try {
      if (operation !== "revoke" && !reasons[key]?.trim())
        throw new Error("请填写核对依据或原因。");
      if (operation === "revoke")
        await action.mutateAsync({
          name: "proofread-revoke",
          request: {
            asset_id: asset,
            decision_id: decisionId,
            expected_manual_revision: first.manual_revision,
            actor: "web",
          },
        });
      else
        await action.mutateAsync({
          name: "proofread-decide",
          request: {
            asset_id: asset,
            proofread_id: current!.proofread_id,
            block_id: item.block_id,
            draft_sha256: item.draft_sha256,
            expected_manual_revision: first.manual_revision,
            action: operation,
            ...(typeof item.page === "number" ? { page: item.page } : {}),
            text: operation === "replace" ? (edited[key] ?? "") : null,
            reason: reasons[key],
            actor: "web",
            suspect_id: suspect?.suspect_id ?? null,
            disposition: suspect ? { status, reason: reasons[key] } : null,
          },
        });
      await archiveWrite(api, "archive", {
        operation: "resume",
        request: { literature_id: id },
      });
      await query.refetch();
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };
  return (
    <section aria-label={archiveStrings.compare}>
      <h2>{archiveStrings.compare}</h2>
      <p className="ui-description">
        以原 PDF
        为依据核对。存疑会保留说明，不阻断就绪。保存人工决定后会重新建档，受影响的既有结果将标为过时。
      </p>
      {failure || action.error ? (
        <ErrorNotice message={failure || errorMessage(action.error)} />
      ) : null}
      {!current ? <p>此材料尚无校订结果；请先完成解析，再发起建档。</p> : null}
      {query
        .data!.pages.flatMap((p) => (Array.isArray(p.pages) ? p.pages : []))
        .map((value) => record(value, "page review"))
        .filter(
          (p) =>
            p.checked === false ||
            p.no_body_reason ||
            (Array.isArray(p.suspects) && p.suspects.length),
        )
        .map((p) => {
          const key = String(p.block_id);
          return (
            <article
              key={key}
              className="archive-field"
              aria-label={`第 ${Number(p.page) + 1} 页的校订状态`}
            >
              <h3>
                第 {Number(p.page) + 1} 页 · {p.checked ? "已核对" : "待核对"}
              </h3>
              <p>
                {p.no_body_reason
                  ? String(p.no_body_reason)
                  : "此页仍有未完成的检查。可以继续校订，或查看原图后人工处置。"}
              </p>
              <RegionToggle
                literature={id}
                asset={asset}
                hash={hash}
                page={Number(p.page) + 1}
                region={null}
              />
              <TextArea
                label={`第 ${Number(p.page) + 1} 页的核对原因`}
                value={reasons[key] ?? ""}
                onChange={(v) => setReasons((old) => ({ ...old, [key]: v }))}
              />
              {(Array.isArray(p.suspects) ? p.suspects : []).map((value) => {
                const suspect = record(value, "page suspect");
                return (
                  <div key={String(suspect.suspect_id)}>
                    <p>
                      {suspectLabels[String(suspect.kind)]}：
                      {Array.isArray(suspect.tokens)
                        ? suspect.tokens.join(" ")
                        : ""}
                    </p>
                    <Button
                      isDisabled={action.isPending || !reasons[key]?.trim()}
                      onPress={() =>
                        void decide(p, "resolve-suspect", suspect, "uncertain")
                      }
                    >
                      保留存疑
                    </Button>
                  </div>
                );
              })}
              <Button
                isDisabled={action.isPending || !reasons[key]?.trim()}
                onPress={() => void decide(p, "no-body")}
              >
                确认此页无正文内容
              </Button>
              {(Array.isArray(p.decisions) ? p.decisions : []).map((value) => {
                const d = record(value, "manual decision");
                return (
                  <Button
                    key={String(d.decision_id)}
                    variant="text"
                    isDisabled={action.isPending}
                    onPress={() =>
                      void decide(
                        p,
                        "revoke",
                        undefined,
                        undefined,
                        String(d.decision_id),
                      )
                    }
                  >
                    撤销人工决定：{String(d.reason)}
                  </Button>
                );
              })}
            </article>
          );
        })}
      {query
        .data!.pages.flatMap((p) => rows(p))
        .map((item) => {
          const draft = record(item.draft, "draft"),
            block = item.block ? record(item.block, "corrected block") : null,
            key = String(item.block_id),
            source = block ?? draft;
          const questions = Array.isArray(item.suspects)
            ? item.suspects.map((s) => record(s, "suspect"))
            : [];
          return (
            <article className="archive-field" key={key}>
              <p>
                第 {Number(source.page) + 1} 页
                {Array.isArray(item.decisions) && item.decisions.length
                  ? " · 已人工锁定"
                  : ""}
                {block?.basis === "uncertain" ? " · 有存疑内容" : ""}
              </p>
              <div className="archive-split">
                <section>
                  <h3>解析初稿</h3>
                  <div
                    className="archive-compare-text"
                    dangerouslySetInnerHTML={{
                      __html: markdown.parse(String(draft.html ?? draft.text)),
                    }}
                  />
                </section>
                <section>
                  <h3>校订稿</h3>
                  <div
                    className="archive-compare-text"
                    dangerouslySetInnerHTML={{
                      __html: markdown.parse(
                        block
                          ? String(block.html ?? block.text)
                          : "经核对已删除此区块",
                      ),
                    }}
                  />
                </section>
              </div>
              {block?.uncertainty ? (
                <p className="ui-description">
                  存疑：
                  {String(record(block.uncertainty, "uncertainty").reason)}
                </p>
              ) : null}
              {questions.map((s) => {
                const disposition = s.disposition
                  ? record(s.disposition, "disposition")
                  : null;
                return (
                  <div key={String(s.suspect_id)}>
                    <p>
                      {suspectLabels[String(s.kind)] ?? "待核对"}：
                      {Array.isArray(s.tokens) ? s.tokens.join(" ") : ""}
                    </p>
                    {disposition ? (
                      <p className="ui-description">
                        {String(disposition.reason)}
                      </p>
                    ) : (
                      <p>尚未处置</p>
                    )}
                    <div className="archive-inline-actions">
                      <Button
                        variant="text"
                        isDisabled={action.isPending || !reasons[key]?.trim()}
                        onPress={() =>
                          void decide(
                            item,
                            "resolve-suspect",
                            s,
                            "draft-correct",
                          )
                        }
                      >
                        初稿无误
                      </Button>
                      <Button
                        variant="text"
                        isDisabled={action.isPending || !reasons[key]?.trim()}
                        onPress={() =>
                          void decide(item, "resolve-suspect", s, "uncertain")
                        }
                      >
                        保留存疑
                      </Button>
                    </div>
                  </div>
                );
              })}
              {Array.isArray(item.edits) && item.edits.length ? (
                <Disclosure title={`矫正记录 · ${item.edits.length}`}>
                  <ul>
                    {item.edits.map((value) => {
                      const entry = record(value, "edit record"),
                        edit = record(entry.edit, "edit");
                      return (
                        <li key={String(entry.edit_id)}>
                          {
                            (
                              {
                                replace: "替换文字",
                                insert_after: "补入区块",
                                delete: "删除非正文",
                                move: "调整页归属",
                                mark_uncertain: "标记存疑",
                              } as Record<string, string>
                            )[String(edit.kind)]
                          }{" "}
                          · 第 {Number(edit.basis_page) + 1} 页 ·{" "}
                          {String(edit.reason)}
                        </li>
                      );
                    })}
                  </ul>
                </Disclosure>
              ) : null}
              <TextArea
                label="核对依据或原因"
                value={reasons[key] ?? ""}
                onChange={(value) =>
                  setReasons((old) => ({ ...old, [key]: value }))
                }
              />
              <Disclosure title="人工修订">
                <TextArea
                  label="修订文字"
                  value={
                    edited[key] ??
                    String(
                      block?.html ??
                        block?.text ??
                        draft.html ??
                        draft.text ??
                        "",
                    )
                  }
                  onChange={(value) =>
                    setEdited((old) => ({ ...old, [key]: value }))
                  }
                />
                <Button
                  isDisabled={
                    action.isPending ||
                    edited[key] === undefined ||
                    !reasons[key]?.trim()
                  }
                  onPress={() => void decide(item, "replace")}
                >
                  保存修订并锁定
                </Button>
                {block?.uncertainty ? (
                  <Button
                    variant="text"
                    isDisabled={action.isPending || !reasons[key]?.trim()}
                    onPress={() => void decide(item, "clear-uncertainty")}
                  >
                    解除存疑
                  </Button>
                ) : null}
                {(Array.isArray(item.decisions) ? item.decisions : []).map(
                  (value) => {
                    const decision = record(value, "manual decision");
                    return (
                      <Button
                        key={String(decision.decision_id)}
                        variant="text"
                        isDisabled={action.isPending}
                        onPress={() =>
                          void decide(
                            item,
                            "revoke",
                            undefined,
                            undefined,
                            String(decision.decision_id),
                          )
                        }
                      >
                        撤销人工决定：{String(decision.reason)}
                      </Button>
                    );
                  },
                )}
              </Disclosure>
              <RegionToggle
                literature={id}
                asset={asset}
                hash={hash}
                page={Number(source.page) + 1}
                region={source.region ? parsePageRegion(source.region) : null}
              />
              <Button
                variant="text"
                onPress={() =>
                  navigate({
                    view: "lib",
                    literature: id,
                    reader: "pdf",
                    source: null,
                    asset,
                    assetHash: hash,
                    page: String(Number(source.page) + 1),
                    region: source.region
                      ? JSON.stringify(source.region)
                      : null,
                  })
                }
              >
                在 PDF 中定位
              </Button>
            </article>
          );
        })}
      {query.hasNextPage ? (
        <Button
          isPending={query.isFetchingNextPage}
          onPress={() => query.fetchNextPage().then(() => {})}
        >
          继续查看区块
        </Button>
      ) : null}
    </section>
  );
}
