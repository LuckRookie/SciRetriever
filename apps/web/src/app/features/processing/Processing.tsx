import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseProcessorReads } from "@sciretriever/contracts";
import {
  Button,
  ErrorNotice,
  PageHeader,
  Section,
  Skeleton,
  Tabs,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { record } from "../../data/wire.js";
import { useShell } from "../../shell/context.js";
import { processorName, sectionRoleNames } from "../../strings.js";
import { processingError } from "./form.js";
import {
  OPERATORS,
  RunOperatorDialog,
  type Operator,
  type OperatorScope,
} from "./RunOperator.js";
import "./processing.css";
const Results = lazy(() => import("./Results.js"));
const Maintenance = lazy(() => import("../maintenance/Maintenance.js"));

/** Operators: run records and results first, the operator catalogue second. */
export default function Processing() {
  const route = useUrlState(),
    api = useApi(),
    shell = useShell(),
    canCreate = api.kind === "workspace";
  const catalog =
    route.parameters.get("tools") === "delivery" ||
    route.parameters.get("tab") === "operators";
  // Older links still arrive with a fixed snapshot or the library selection.
  const snapshot = route.parameters.get("snapshot"),
    processor = route.parameters.get("processor");
  const [dialog, setDialog] = useState<{
    fixed?: { scope: OperatorScope; label: string };
    operator?: Operator;
  } | null>(() =>
    !canCreate
      ? null
      : snapshot
        ? {
            fixed: {
              scope: { kind: "snapshot", id: snapshot },
              label: "所选快照",
            },
            ...(processor ? { operator: processor as Operator } : {}),
          }
        : route.parameters.get("scope") === "selection" && shell.selected.size
          ? {
              fixed: {
                scope: { kind: "literatures", ids: [...shell.selected] },
                label: `已选的 ${shell.selected.size} 篇`,
              },
            }
          : null,
  );
  return (
    <section className="feature-page processing-page">
      <PageHeader
        title="算子"
        description="在一批文献上运行算子，回看运行记录与结果。"
        action={
          canCreate ? (
            <Button variant="primary" onPress={() => setDialog({})}>
              运行算子
            </Button>
          ) : undefined
        }
      />
      <Tabs
        label="算子分区"
        value={catalog ? "operators" : "runs"}
        onChange={(value) =>
          navigate({
            view: "ext",
            result: null,
            resultHash: null,
            collection: null,
            snapshot: null,
            processor: null,
            scope: null,
            results: value === "runs" ? "all" : null,
            tab: value === "operators" ? "operators" : null,
            tools: null,
          })
        }
        items={[
          { id: "runs", label: "运行记录" },
          { id: "operators", label: "算子与规范" },
        ]}
      >
        <Suspense fallback={<Skeleton />}>
          {catalog ? (
            <OperatorCatalog
              canCreate={canCreate}
              onRun={(operator) => setDialog({ operator })}
            />
          ) : (
            <Results />
          )}
        </Suspense>
      </Tabs>
      {dialog ? (
        <RunOperatorDialog
          {...(dialog.fixed ? { fixed: dialog.fixed } : {})}
          {...(dialog.operator ? { initialOperator: dialog.operator } : {})}
          onClose={() => {
            setDialog(null);
            if (snapshot || route.parameters.has("scope"))
              navigate(
                { snapshot: null, processor: null, scope: null },
                { replace: true },
              );
          }}
        />
      ) : null}
    </section>
  );
}
function OperatorCatalog({
  canCreate,
  onRun,
}: {
  canCreate: boolean;
  onRun: (operator: Operator) => void;
}) {
  const api = useApi();
  const registry = useQuery({
    queryKey: ["processors"],
    queryFn: ({ signal }) =>
      api.processors("list", {}, signal).then((v) => {
        if (!Array.isArray(v.result)) throw new Error("算子注册表无效");
        return v.result.map((raw) => record(raw, "processor"));
      }),
  });
  return (
    <>
      <Section
        title="内置算子"
        description="每个算子读取什么、产出什么由算子定义决定；运行时只需要选择范围并填写规范。"
      >
        {registry.isPending ? <Skeleton rows={3} /> : null}
        {registry.error ? (
          <ErrorNotice message={processingError(registry.error)} />
        ) : null}
        <ul className="operator-catalog">
          {OPERATORS.map((operator) => {
            const entry = registry.data?.find((p) => p.id === operator.id);
            const reads = entry?.reads
              ? parseProcessorReads(entry.reads)
              : null;
            return (
              <li key={operator.id}>
                <div>
                  <h3>{processorName(operator.id)}</h3>
                  <p>{operator.description}</p>
                  <p className="operator-catalog-meta">
                    {entry ? `版本 ${String(entry.version)}` : "当前服务不可用"}
                    {reads
                      ? ` · 读取${
                          {
                            main: "正文",
                            supplementary: "补充材料",
                            all: "正文与补充材料",
                          }[reads.parts]
                        } · ${
                          reads.roles === "all"
                            ? "全部章节"
                            : reads.roles
                                .map((r) => sectionRoleNames[r] ?? "其他章节")
                                .join("、")
                        }`
                      : ""}
                  </p>
                </div>
                {canCreate ? (
                  <Button
                    isDisabled={!entry}
                    onPress={() => onRun(operator.id)}
                  >
                    运行
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section
        title="规范与外部交付"
        description="管理保存的提取规范，或把规范交给外部工具执行后交回结果。"
      >
        <Suspense fallback={<Skeleton />}>
          <Maintenance deliveryOnly />
        </Suspense>
      </Section>
    </>
  );
}
