import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  ErrorNotice,
  Select,
  Skeleton,
} from "../../components/index.js";
import { archiveQuery, rows, useArchiveAction } from "../../data/archive.js";
import { useApi } from "../../data/query.js";
import { record } from "../../data/wire.js";
import { errorMessage } from "../../strings.js";

const stepLabels = {
  proofread: "校订",
  render: "全文发布",
  structure: "章节注释",
  references: "引用关系",
} as const;

/** Explicit single-stage operations reuse the same public contracts as CLI/MCP. */
export function StepActions({ id }: { id: string }) {
  const api = useApi(),
    action = useArchiveAction();
  const [open, setOpen] = useState(false),
    [asset, setAsset] = useState(""),
    [step, setStep] = useState("proofread"),
    [notice, setNotice] = useState("");
  const state = useQuery({
    queryKey: ["archive", "single-step", id],
    enabled: open,
    queryFn: async ({ signal }) => {
      const [status, documents] = await Promise.all([
        archiveQuery(
          api,
          "archive",
          { operation: "status", request: { literature_id: id } },
          signal,
        ),
        archiveQuery(
          api,
          "document-parts",
          { literature_id: id, offset: 0, limit: 200 },
          signal,
        ),
      ]);
      const parts = rows(status, "parts");
      const arrangements = await Promise.all(
        parts.map((p) =>
          archiveQuery(
            api,
            "archive-arrangement",
            {
              schema_version: 2,
              asset_id: p.asset_id,
              proofread_id: null,
              kind: "summary",
            },
            signal,
          ).then((v) => record(v, "arrangement summary")),
        ),
      );
      return { parts, documents: rows(documents, "parts"), arrangements };
    },
  });
  const parts = state.data?.parts ?? [],
    part = parts.find((p) => p.asset_id === asset) ?? parts[0];
  const document = state.data?.documents.find(
    (p) => p.asset_id === part?.asset_id,
  );
  const current = document?.default
    ? record(document.default, "document default")
    : null;
  const arrangement = part
    ? state.data?.arrangements[parts.indexOf(part)]
    : undefined;
  const arrangementId =
    arrangement?.format === "arranged-v2" &&
    typeof arrangement.arrangement_id === "string"
      ? arrangement.arrangement_id
      : null;
  const allowed =
    !!part &&
    (step === "proofread"
      ? arrangementId !== null
      : step === "render"
        ? part.proofread_complete === true && arrangementId !== null
        : step === "structure"
          ? !!part.document_version_id && arrangementId !== null
          : part.part === "main" &&
            !!part.document_version_id &&
            !!part.structure_annotation_id);
  const submit = () => {
    if (!part || !allowed) return;
    setNotice("");
    const operation =
      step === "proofread"
        ? {
            name: "proofread-build",
            request: {
              schema_version: 2,
              asset_id: part.asset_id,
              arrangement_id: arrangementId,
              retry_page_indexes: null,
            },
          }
        : step === "render"
          ? {
              name: "document-publish-proofread",
              request: {
                schema_version: 2,
                literature_id: id,
                asset_id: part.asset_id,
                proofread_id: part.proofread_id,
                expected_default_revision: current?.revision ?? null,
              },
            }
          : step === "structure"
            ? {
                name: "document-annotate",
                request: {
                  schema_version: 2,
                  document_version_id: part.document_version_id,
                  arrangement_id: arrangementId,
                },
              }
            : {
                name: "archive-references",
                request: {
                  literature_id: id,
                  document_version_id: part.document_version_id,
                  annotation_id: part.structure_annotation_id,
                },
              };
    action.mutate(operation, {
      onSuccess: () => {
        setNotice("此步骤已完成。后续步骤由你按需启动。");
        void state.refetch();
      },
    });
  };
  return (
    <>
      <Button
        variant="text"
        isDisabled={!api.workspace.capabilities.maintenance}
        onPress={() => {
          setNotice("");
          setOpen(true);
        }}
      >
        单步处理
      </Button>
      <Dialog
        title="单步处理文献"
        isOpen={open}
        onOpenChange={setOpen}
        footer={
          <Button
            isDisabled={!allowed}
            isPending={action.isPending}
            onPress={submit}
          >
            确认执行此步骤
          </Button>
        }
      >
        {state.isPending ? <Skeleton label="正在读取材料状态" /> : null}
        {state.error || action.error ? (
          <ErrorNotice message={errorMessage(state.error ?? action.error)} />
        ) : null}
        <Select
          label="处理部分"
          value={String(part?.asset_id ?? "")}
          onChange={setAsset}
          options={parts.map((p, i) => ({
            value: String(p.asset_id),
            label: p.part === "main" ? "正文" : `补充材料 ${i + 1}`,
          }))}
        />
        <Select
          label="处理步骤"
          value={step}
          onChange={(v) => {
            setStep(v);
            setNotice("");
          }}
          options={Object.entries(stepLabels).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <p>
          {step === "proofread" ? "此步骤会调用模型。" : "此步骤不调用模型。"}
          仅执行所选步骤，不自动继续其他加工。
        </p>
        {!allowed && !state.isPending ? (
          <p>
            {part && !arrangementId
              ? "所选部分还没有按新流程整理，请先解析全文。"
              : "所选部分尚不具备此步骤需要的材料，请先完成前置步骤。"}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </Dialog>
    </>
  );
}
