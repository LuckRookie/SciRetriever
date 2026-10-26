import { serviceMessage } from "../../strings.js";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseConfigurationReadiness } from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Definition,
  Definitions,
  Dialog,
  ErrorNotice,
  Icon,
  IconButton,
  PageHeader,
  Radio,
  RadioGroup,
  Section,
  Select,
  Switch,
  Tabs,
  TechDetails,
  TextField,
  NumberField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { useUrlState, registerNavigationGuard } from "../../data/url.js";
import { preferences, type Theme } from "../../data/preferences.js";
import { useShell } from "../../shell/context.js";
import { useMotionPreference } from "../../motion/index.js";
import { record, type JsonRecord } from "../../data/wire.js";
import { copyText, randomId } from "../../../browser-platform.js";
import { errorMessage } from "../../strings.js";
import {
  MODEL_APIS,
  MODEL_REASONING,
  SOURCE_LABELS,
  SOURCE_PROVIDERS,
  runtimeStatus,
} from "./configuration-data.js";
import "./settings.css";

const Maintenance = lazy(() => import("../maintenance/Maintenance.js"));
const tabs = [
  { id: "paths", label: "文献库位置" },
  { id: "sources", label: "文献来源" },
  { id: "models", label: "模型" },
  { id: "parser", label: "解析与 Browser" },
  { id: "archive", label: "建档" },
  { id: "cred", label: "凭据" },
  { id: "status", label: "运行状态" },
  { id: "appearance", label: "外观" },
  { id: "advanced", label: "高级" },
];
const str = (value: unknown) => (typeof value === "string" ? value : "");
interface ProviderRow {
  id: string;
  name: string;
  api: string;
  url: string;
}
interface ModelRow {
  id: string;
  provider: string;
  name: string;
  reasoning: string;
  image: boolean;
  stream: boolean;
}
function registry(config: JsonRecord) {
  return {
    providers: Object.entries(record(config.providers, "providers")).map(
      ([name, value]) => {
        const provider = record(value, "provider");
        return {
          id: randomId(),
          name,
          api: str(provider.api),
          url: str(provider.base_url),
        };
      },
    ),
    models: Object.entries(record(config.models, "models")).map(
      ([ref, value]) => {
        const model = record(value, "model"),
          slash = ref.indexOf("/");
        return {
          id: randomId(),
          provider: ref.slice(0, slash),
          name: ref.slice(slash + 1),
          reasoning: str(model.reasoning) || "default",
          image: model.image === true,
          stream: model.stream === true,
        };
      },
    ),
  };
}
export default function Settings() {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient(),
    route = useUrlState();
  const [section, setSection] = useState(
      route.parameters.get("setting") ??
        (api.kind === "workspace" ? "paths" : "appearance"),
    ),
    [draft, setDraft] = useState<JsonRecord | null>(null),
    [snapshot, setSnapshot] = useState<JsonRecord | null>(null),
    [runtime, setRuntime] = useState<JsonRecord>({}),
    [providers, setProviders] = useState<ProviderRow[]>([]),
    [models, setModels] = useState<ModelRow[]>([]),
    [dirty, setDirty] = useState(new Set<string>()),
    [message, setMessage] = useState(""),
    [refreshConfirm, setRefreshConfirm] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const leaveDecision = useRef<((allow: boolean) => void) | null>(null);
  useEffect(() => {
    if (!dirty.size) return;
    return registerNavigationGuard(
      () =>
        new Promise<boolean>((resolve) => {
          leaveDecision.current = resolve;
          setLeaveConfirm(true);
        }),
    );
  }, [dirty.size]);
  const decideLeave = (allow: boolean) => {
    setLeaveConfirm(false);
    leaveDecision.current?.(allow);
    leaveDecision.current = null;
  };
  const read = useQuery({
    queryKey: ["configuration", "read"],
    queryFn: ({ signal }) => api.read("/api/configuration/read", signal),
    enabled: api.kind === "workspace" && section !== "appearance",
    retry: false,
  });
  const readiness = useQuery({
    queryKey: ["configuration", "status"],
    queryFn: async ({ signal }) =>
      parseConfigurationReadiness(
        (await api.read("/api/configuration/status", signal)).status,
      ),
    enabled: api.kind === "workspace",
    retry: false,
  });
  const accept = (value: JsonRecord) => {
    const saved = record(value.snapshot, "snapshot"),
      config = record(saved.configuration, "configuration"),
      rows = registry(config);
    setSnapshot(saved);
    setDraft(structuredClone(config));
    setProviders(rows.providers);
    setModels(rows.models);
    setDirty(new Set());
    setRuntime(value);
  };
  useEffect(() => {
    if (read.data && !snapshot) accept(read.data);
  }, [read.data, snapshot]);
  useEffect(() => {
    if (!dirty.size) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty.size]);
  const mark = (name: string) => setDirty((value) => new Set([...value, name]));
  const edit = (name: string, key: string, value: unknown) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            [name]: { ...record(current[name], name), [key]: value },
          }
        : current,
    );
    mark(name);
  };
  const guard = useRef(false);
  const publish = useMutation({
    mutationFn: async ({
      sections,
      configuration,
    }: {
      sections: string[];
      configuration: JsonRecord;
    }) => {
      if (!snapshot) throw new Error("请先读取当前配置。");
      return api.request("/api/configuration/publish-json", {
        configuration,
        baseline: snapshot.revision,
        sections,
      });
    },
    onSuccess: async (result, variables) => {
      const saved = record(result.snapshot, "snapshot"),
        config = record(saved.configuration, "configuration");
      setSnapshot(saved);
      setRuntime(result);
      setDraft((current) => {
        const next = { ...(current ?? config) };
        for (const name of variables.sections)
          next[name] = structuredClone(config[name]);
        return next;
      });
      if (variables.sections.includes("providers")) {
        const rows = registry(config);
        setProviders(rows.providers);
        setModels(rows.models);
      }
      setDirty(
        (current) =>
          new Set(
            [...current].filter((name) => !variables.sections.includes(name)),
          ),
      );
      const text = variables.sections.includes("paths")
        ? "数据库绑定已保存。当前进程继续使用启动时的数据库；重启服务后生效。已有数据没有移动。"
        : `${variables.sections.includes("sources") ? "来源配置" : variables.sections.includes("providers") ? "Provider/Model" : "运行配置"}已保存并重新读取。${result.application_restart_required === true ? "当前服务需重启后应用新配置。" : ""}`;
      setMessage(text);
      shell.notify(text);
      try {
        await queries.fetchQuery({
          queryKey: ["configuration", "status"],
          queryFn: async ({ signal }) =>
            parseConfigurationReadiness(
              (await api.read("/api/configuration/status", signal)).status,
            ),
          staleTime: 0,
        });
      } catch {
        setMessage(`${text} 状态读取失败，可刷新状态重试；保存已完成。`);
      }
    },
    onError: (error) =>
      setMessage(
        error instanceof Error &&
          "code" in error &&
          error.code === "configuration-conflict"
          ? "保存遇到 revision 冲突；草稿仍保留。请刷新当前保存值后再修正。"
          : `保存结果未确认：${errorMessage(error)}。草稿仍保留，请核对后重试。`,
      ),
    onSettled: () => {
      guard.current = false;
    },
  });
  const save = (sections: string[], configuration = draft) => {
    if (!configuration || guard.current) return;
    guard.current = true;
    setMessage("正在校验并保存…");
    publish.mutate({ sections, configuration });
  };
  const refresh = async () => {
    setRefreshConfirm(false);
    try {
      const response = await read.refetch();
      if (response.error) throw response.error;
      if (response.data) accept(response.data);
      await readiness.refetch();
      setMessage("已重新读取保存的配置。");
    } catch (error) {
      setMessage(`配置读取失败：${errorMessage(error)}`);
    }
  };
  const value = (name: string, key: string) =>
    draft ? record(draft[name], name)[key] : null;
  const modelOptions = [
    { value: "", label: "未选择" },
    ...Object.keys(draft ? record(draft.models, "models") : {}).map(
      (value) => ({ value, label: value }),
    ),
  ];
  const runtimeNote = runtimeStatus(runtime);
  const saveModels = () => {
    if (!draft) return;
    try {
      const nextProviders: JsonRecord = {},
        nextModels: JsonRecord = {};
      for (const row of providers) {
        if (!row.name.trim() || !row.api || !row.url.trim())
          throw new Error("每个 Provider 都需要名称、协议和 Base URL。");
        if (Object.hasOwn(nextProviders, row.name.trim()))
          throw new Error("Provider 名称重复。");
        nextProviders[row.name.trim()] = {
          api: row.api,
          base_url: row.url.trim(),
        };
      }
      for (const row of models) {
        if (
          !row.provider ||
          !row.name.trim() ||
          !Object.hasOwn(nextProviders, row.provider)
        )
          throw new Error("每个模型需要已注册的 Provider 和远程名称。");
        const ref = `${row.provider}/${row.name.trim()}`;
        if (Object.hasOwn(nextModels, ref)) throw new Error("模型名称重复。");
        nextModels[ref] = {
          reasoning: row.reasoning,
          image: row.image,
          stream: row.stream,
        };
      }
      for (const role of ["analyze", "browser"]) {
        const savedConfig = snapshot
            ? record(snapshot.configuration, "saved configuration")
            : null,
          savedRef = savedConfig ? record(savedConfig[role], role).model : null;
        if (savedRef && !Object.hasOwn(nextModels, String(savedRef)))
          throw new Error(
            `当前保存的 ${role === "browser" ? "Browser" : "分析"} 配置仍引用这个模型，请先调整并保存角色绑定。`,
          );
        const ref = value(role, "model");
        if (ref && !Object.hasOwn(nextModels, String(ref)))
          throw new Error(`模型仍绑定 ${role}，请先保存新的角色绑定。`);
        if (
          role === "browser" &&
          ref &&
          record(nextModels[String(ref)], "model").image !== true
        )
          throw new Error("Browser 绑定需要支持图像的模型，请先调整绑定。");
      }
      save(["providers", "models"], {
        ...draft,
        providers: nextProviders,
        models: nextModels,
      });
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  const changed = (...names: string[]) => names.some((name) => dirty.has(name));
  /** A section's save button exists only while that section has unsaved edits. */
  const saveButton = (
    names: string[],
    label: string,
    onPress: () => void = () => save(names),
  ) =>
    changed(...names) ? (
      <Button variant="primary" isPending={publish.isPending} onPress={onPress}>
        {label}
      </Button>
    ) : undefined;
  const runtimeSections = [
    "browser",
    "parsing",
    "analyze",
    "tags",
    "proofread",
  ];
  const sectionTabs =
    api.kind === "workspace"
      ? tabs
      : tabs.filter(
          (tab) =>
            tab.id === "appearance" ||
            (api.kind === "maintenance" && tab.id === "advanced"),
        );
  const pathValue = (path: string | null | undefined, label: string) =>
    path ? (
      <span className="settings-path">
        <code title={path}>{path}</code>
        <IconButton
          size="inline"
          variant="text"
          aria-label={`复制${label}`}
          icon={<Icon name="copy" />}
          onPress={() =>
            void copyText(path).then(() => shell.notify(`${label}已复制`))
          }
        />
      </span>
    ) : (
      "当前进程未提供"
    );
  return (
    <section className="settings-page">
      <PageHeader
        title="设置"
        action={
          <Button
            isDisabled={publish.isPending}
            onPress={() =>
              dirty.size ? setRefreshConfirm(true) : void refresh()
            }
          >
            刷新配置
          </Button>
        }
      />
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置分区导航">
          <Tabs
            label="设置分区"
            orientation="vertical"
            value={section}
            onChange={setSection}
            items={sectionTabs}
          />
          <div className="settings-navigation-narrow">
            <Select
              label="设置分区"
              value={section}
              onChange={setSection}
              options={sectionTabs.map((tab) => ({
                value: tab.id,
                label: tab.label,
              }))}
            />
          </div>
        </nav>
        <div className="settings-content">
          {section === "appearance" ? (
            <Appearance />
          ) : section === "advanced" ? (
            <Suspense fallback={<p role="status">正在打开高级工具…</p>}>
              <Maintenance />
            </Suspense>
          ) : read.isPending ? (
            <p role="status">正在读取配置…</p>
          ) : read.isError ? (
            <ErrorNotice message="配置读取失败，请重试。" onRetry={refresh} />
          ) : (
            draft && (
              <>
                {section === "paths" && (
                  <>
                    <Section
                      title="文献库位置"
                      action={saveButton(["paths"], "保存文献库位置")}
                    >
                      <Definitions>
                        <Definition
                          term="Catalog 路径"
                          description="修改后重启服务生效，已有文件不会移动。"
                          value={pathValue(api.workspace.catalog, "数据库路径")}
                        >
                          <TextField
                            label="Catalog 路径"
                            value={str(value("paths", "catalog_path"))}
                            onChange={(value) =>
                              edit("paths", "catalog_path", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="资产目录"
                          description="PDF、解析材料与校订稿存放的位置。"
                          value={pathValue(api.workspace.artifacts, "资产目录")}
                        >
                          <TextField
                            label="资产目录"
                            value={str(value("paths", "artifact_root"))}
                            onChange={(value) =>
                              edit("paths", "artifact_root", value || null)
                            }
                          />
                        </Definition>
                      </Definitions>
                    </Section>
                    <Section title="当前登录">
                      <Definitions>
                        <Definition
                          term="退出登录"
                          description="释放当前浏览器连接；已提交的后台任务继续运行。"
                        >
                          <Button
                            onPress={() =>
                              void api
                                .logout()
                                .catch((error: unknown) =>
                                  setMessage(errorMessage(error)),
                                )
                            }
                          >
                            退出登录
                          </Button>
                        </Definition>
                      </Definitions>
                    </Section>
                  </>
                )}
                {section === "sources" && (
                  <Sources
                    configuration={draft}
                    onChange={(sources) => {
                      setDraft({ ...draft, sources });
                      mark("sources");
                    }}
                    onSave={() => save(["sources"])}
                    pending={publish.isPending}
                    dirty={changed("sources")}
                  />
                )}
                {section === "models" && (
                  <>
                    <Section
                      title="模型服务"
                      description="Provider 定义连接协议，Model 记录远程模型与能力；凭据在“凭据”分区保存。"
                      action={saveButton(
                        ["providers", "models"],
                        "保存 Provider/Model",
                        saveModels,
                      )}
                    >
                      <div className="settings-registry">
                        <h3>Provider</h3>
                        {providers.map((row, index) => (
                          <fieldset key={row.id}>
                            <legend>Provider {index + 1}</legend>
                            <div className="settings-grid">
                              <TextField
                                label={`Provider ${index + 1} 名称`}
                                value={row.name}
                                onChange={(name) => {
                                  setProviders(
                                    providers.map((item) =>
                                      item.id === row.id
                                        ? { ...item, name }
                                        : item,
                                    ),
                                  );
                                  mark("providers");
                                }}
                              />
                              <Select
                                label={`Provider ${index + 1} 协议`}
                                value={row.api}
                                onChange={(api) => {
                                  setProviders(
                                    providers.map((item) =>
                                      item.id === row.id
                                        ? { ...item, api }
                                        : item,
                                    ),
                                  );
                                  mark("providers");
                                }}
                                options={MODEL_APIS}
                              />
                              <TextField
                                label={`Provider ${index + 1} Base URL`}
                                value={row.url}
                                onChange={(url) => {
                                  setProviders(
                                    providers.map((item) =>
                                      item.id === row.id
                                        ? { ...item, url }
                                        : item,
                                    ),
                                  );
                                  mark("providers");
                                }}
                              />
                              <Button
                                variant="text"
                                onPress={() => {
                                  if (
                                    models.some(
                                      (model) => model.provider === row.name,
                                    )
                                  ) {
                                    setMessage(
                                      "Provider 仍有模型引用，请先移除或调整模型。",
                                    );
                                    return;
                                  }
                                  setProviders(
                                    providers.filter(
                                      (item) => item.id !== row.id,
                                    ),
                                  );
                                  mark("providers");
                                }}
                              >
                                移除 Provider
                              </Button>
                            </div>
                          </fieldset>
                        ))}
                        <Button
                          onPress={() => {
                            setProviders([
                              ...providers,
                              {
                                id: randomId(),
                                name: "",
                                api: "openai-responses",
                                url: "",
                              },
                            ]);
                            mark("providers");
                          }}
                        >
                          添加 Provider
                        </Button>
                        <h3>Model</h3>
                        {models.map((row, index) => (
                          <fieldset key={row.id}>
                            <legend>Model {index + 1}</legend>
                            <div className="settings-grid">
                              <Select
                                label={`Model ${index + 1} Provider`}
                                value={row.provider}
                                onChange={(provider) => {
                                  setModels(
                                    models.map((item) =>
                                      item.id === row.id
                                        ? { ...item, provider }
                                        : item,
                                    ),
                                  );
                                  mark("models");
                                }}
                                options={[
                                  { value: "", label: "请选择" },
                                  ...providers
                                    .filter((provider) => provider.name)
                                    .map((provider) => ({
                                      value: provider.name,
                                      label: provider.name,
                                    })),
                                ]}
                              />
                              <TextField
                                label={`Model ${index + 1} 远程名称`}
                                value={row.name}
                                onChange={(name) => {
                                  setModels(
                                    models.map((item) =>
                                      item.id === row.id
                                        ? { ...item, name }
                                        : item,
                                    ),
                                  );
                                  mark("models");
                                }}
                              />
                              <Select
                                label={`Model ${index + 1} Reasoning`}
                                value={row.reasoning}
                                onChange={(reasoning) => {
                                  setModels(
                                    models.map((item) =>
                                      item.id === row.id
                                        ? { ...item, reasoning }
                                        : item,
                                    ),
                                  );
                                  mark("models");
                                }}
                                options={MODEL_REASONING.map((value) => ({
                                  value,
                                  label: value,
                                }))}
                              />
                              <Checkbox
                                label={`Model ${index + 1} 支持图像`}
                                isSelected={row.image}
                                onChange={(image) => {
                                  setModels(
                                    models.map((item) =>
                                      item.id === row.id
                                        ? { ...item, image }
                                        : item,
                                    ),
                                  );
                                  mark("models");
                                }}
                              />
                              <Checkbox
                                label={`Model ${index + 1} 流式输出`}
                                isSelected={row.stream}
                                onChange={(stream) => {
                                  setModels(
                                    models.map((item) =>
                                      item.id === row.id
                                        ? { ...item, stream }
                                        : item,
                                    ),
                                  );
                                  mark("models");
                                }}
                              />
                              <Button
                                variant="text"
                                onPress={() => {
                                  const ref = `${row.provider}/${row.name}`;
                                  if (
                                    value("browser", "model") === ref ||
                                    value("analyze", "model") === ref
                                  ) {
                                    setMessage(
                                      "模型仍有角色绑定，请先调整并保存角色绑定。",
                                    );
                                    return;
                                  }
                                  setModels(
                                    models.filter((item) => item.id !== row.id),
                                  );
                                  mark("models");
                                }}
                              >
                                移除 Model
                              </Button>
                            </div>
                            <Probe
                              owner="model"
                              target={`${row.provider}/${row.name}`}
                              image={row.image}
                            />
                          </fieldset>
                        ))}
                        <Button
                          onPress={() => {
                            setModels([
                              ...models,
                              {
                                id: randomId(),
                                provider: providers[0]?.name ?? "",
                                name: "",
                                reasoning: "default",
                                image: false,
                                stream: true,
                              },
                            ]);
                            mark("models");
                          }}
                        >
                          添加 Model
                        </Button>
                      </div>
                    </Section>
                    <Section
                      title="角色绑定"
                      description="标签任务未单独指定时使用分析模型；元数据与章节角色也使用分析模型。"
                      action={saveButton(runtimeSections, "保存角色绑定")}
                    >
                      <Definitions>
                        <Definition
                          term="分析模型"
                          description="单篇处理、元数据与章节角色。"
                        >
                          <Select
                            label="分析模型"
                            value={str(value("analyze", "model"))}
                            onChange={(value) =>
                              edit("analyze", "model", value || null)
                            }
                            options={modelOptions}
                          />
                        </Definition>
                        <Definition
                          term="校订矫正模型"
                          description="未指定时沿用分析模型，须支持图片与工具。"
                        >
                          <Select
                            label="校订矫正模型"
                            value={str(value("proofread", "model"))}
                            onChange={(v) =>
                              edit("proofread", "model", v || null)
                            }
                            options={modelOptions}
                          />
                        </Definition>
                        {[
                          ["model", "文献打标模型"],
                          ["consolidation_model", "词表整理模型"],
                          ["backfill_model", "标签回溯模型"],
                        ].map(([key, label]) => (
                          <Definition key={key} term={label!}>
                            <Select
                              label={label!}
                              value={str(value("tags", key!))}
                              onChange={(v) => edit("tags", key!, v || null)}
                              options={modelOptions}
                            />
                          </Definition>
                        ))}
                        <Definition
                          term="Browser 模型"
                          description="须支持图像。"
                        >
                          <Select
                            label="Browser 模型"
                            value={str(value("browser", "model"))}
                            onChange={(value) =>
                              edit("browser", "model", value || null)
                            }
                            options={modelOptions.map((option) => ({
                              ...option,
                              disabled:
                                !!option.value &&
                                record(
                                  record(draft.models, "models")[option.value],
                                  "model",
                                ).image !== true,
                            }))}
                          />
                        </Definition>
                      </Definitions>
                    </Section>
                  </>
                )}
                {section === "archive" && (
                  <Section
                    title="建档与标签"
                    description="元数据和章节判定使用“模型”分区的分析模型。"
                    action={saveButton(["tags", "proofread"], "保存建档设置")}
                  >
                    <Definitions>
                      {[
                        ["max_per_literature", "每篇标签上限", 1, 32],
                        ["candidate_k", "候选检索数量", 1, 64],
                        ["backfill_batch", "回溯批量", 1, 64],
                      ].map(([key, label, min, max]) => (
                        <Definition
                          key={String(key)}
                          term={String(label)}
                          description={`${String(min)}–${String(max)}`}
                        >
                          <NumberField
                            live
                            label={String(label)}
                            minValue={Number(min)}
                            maxValue={Number(max)}
                            value={Number(value("tags", String(key)) ?? min)}
                            onChange={(v) => edit("tags", String(key), v)}
                          />
                        </Definition>
                      ))}
                      <Definition
                        term="每篇矫正调用上限"
                        description="1–10,000"
                      >
                        <NumberField
                          live
                          label="每篇矫正调用上限"
                          minValue={1}
                          maxValue={10000}
                          value={Number(
                            value("proofread", "max_calls_per_document") ?? 64,
                          )}
                          onChange={(v) =>
                            edit("proofread", "max_calls_per_document", v)
                          }
                        />
                      </Definition>
                      <Definition
                        term="解析 profile"
                        description="部署配置，只读。"
                      >
                        <span className="settings-readonly">
                          {str(value("parsing", "archive_profile")) ||
                            "vlm-engine"}
                        </span>
                      </Definition>
                    </Definitions>
                  </Section>
                )}
                {section === "parser" && (
                  <>
                    <Section
                      title="Browser"
                      action={saveButton(runtimeSections, "保存运行配置")}
                    >
                      <Definitions>
                        <Definition
                          term="启用 Browser"
                          description="获取 PDF 时可以打开受控浏览器。"
                        >
                          <Switch
                            isSelected={value("browser", "enabled") === true}
                            onChange={(value) =>
                              edit("browser", "enabled", value)
                            }
                          >
                            启用 Browser
                          </Switch>
                        </Definition>
                        <Definition term="Browser profile">
                          <TextField
                            label="Browser profile"
                            value={str(value("browser", "profile"))}
                            onChange={(value) =>
                              edit("browser", "profile", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="Browser 模型"
                          description="与“模型”分区的角色绑定相同。"
                        >
                          <Select
                            label="Browser 模型"
                            value={str(value("browser", "model"))}
                            onChange={(value) =>
                              edit("browser", "model", value || null)
                            }
                            options={modelOptions}
                          />
                        </Definition>
                        <Definition
                          term="连接测试"
                          description="使用已保存的配置和凭据，可能消耗模型额度。"
                        >
                          <Probe owner="browser-model" image />
                        </Definition>
                      </Definitions>
                    </Section>
                    <Section title="MinerU 解析">
                      <Definitions>
                        <Definition term="服务地址">
                          <TextField
                            label="MinerU 服务地址"
                            value={str(value("parsing", "base_url"))}
                            onChange={(value) =>
                              edit("parsing", "base_url", value || null)
                            }
                          />
                        </Definition>
                        <Definition term="连接模式">
                          <Select
                            label="MinerU 连接模式"
                            value={str(value("parsing", "connection_mode"))}
                            onChange={(value) =>
                              edit("parsing", "connection_mode", value || null)
                            }
                            options={[
                              { value: "", label: "未配置" },
                              { value: "loopback", label: "本机 loopback" },
                              { value: "remote", label: "远程 HTTPS" },
                            ]}
                          />
                        </Definition>
                        <Definition term="模型">
                          <TextField
                            label="MinerU 模型"
                            value={str(value("parsing", "model_identity"))}
                            onChange={(value) =>
                              edit("parsing", "model_identity", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="连接测试"
                          description="使用已保存的配置访问解析服务。"
                        >
                          <Probe owner="parse" />
                        </Definition>
                      </Definitions>
                    </Section>
                  </>
                )}
                {section === "cred" && (
                  <Credential
                    baseline={str(snapshot?.revision)}
                    onResult={(result) => {
                      setRuntime(result);
                      void readiness.refetch();
                    }}
                  />
                )}
                {section === "status" && (
                  <Section
                    title="运行状态"
                    action={
                      <Button onPress={() => void readiness.refetch()}>
                        刷新状态
                      </Button>
                    }
                  >
                    <p
                      className="settings-runtime"
                      data-state={runtimeNote.state}
                    >
                      {runtimeNote.message}
                    </p>
                    {readiness.isError ? (
                      <ErrorNotice
                        message="状态读取失败，已保存配置保持不变。"
                        onRetry={() => void readiness.refetch()}
                      />
                    ) : (
                      <Definitions>
                        {readiness.data?.items.map((item) => (
                          <Definition
                            key={`${item.owner}/${item.target}`}
                            term={`${item.owner} / ${item.target}`}
                            description={item.next_action}
                          >
                            <span className="settings-readonly">
                              {item.state}
                            </span>
                          </Definition>
                        ))}
                      </Definitions>
                    )}
                  </Section>
                )}
              </>
            )
          )}
          {dirty.size > 0 && (
            <p className="settings-draft-note" role="status">
              有未保存的修改；切换设置分区会保留草稿。
            </p>
          )}
          <p role={publish.isError ? "alert" : "status"}>{message}</p>
          {snapshot && (
            <TechDetails>
              <p>
                配置版本：<code>{str(snapshot.revision)}</code>
              </p>
            </TechDetails>
          )}
        </div>
      </div>
      <Dialog
        title="保留未保存的修改？"
        isOpen={leaveConfirm}
        onOpenChange={(open) => {
          if (!open) decideLeave(false);
        }}
        footer={
          <>
            <Button onPress={() => decideLeave(false)}>继续编辑</Button>
            <Button variant="danger" onPress={() => decideLeave(true)}>
              放弃并离开
            </Button>
          </>
        }
      >
        <p>当前设置中有未保存的修改。切换到其他页面会丢弃这些草稿。</p>
      </Dialog>
      <Dialog
        title="重新读取配置"
        isOpen={refreshConfirm}
        onOpenChange={setRefreshConfirm}
        footer={
          <>
            <Button onPress={() => setRefreshConfirm(false)}>保留草稿</Button>
            <Button variant="primary" onPress={() => void refresh()}>
              读取保存值
            </Button>
          </>
        }
      >
        <p>当前未保存的修改将被保存值替换。</p>
      </Dialog>
    </section>
  );
}
function Appearance() {
  const shell = useShell(),
    motion = useMotionPreference();
  const [font, setFont] = useState(
      preferences.read("sciretriever:reading:font:v1") ?? "20",
    ),
    [width, setWidth] = useState(
      preferences.read("sciretriever:reading:width:v1") ?? "comfortable",
    );
  return (
    <Section
      title="外观与阅读"
      description="偏好保存在当前浏览器，不会更改文献库内容。"
    >
      <Definitions>
        <Definition term="主题">
          <Select
            label="主题"
            value={shell.theme}
            onChange={(value) => shell.setTheme(value as Theme)}
            options={[
              { value: "light", label: "蓝白" },
              { value: "dark", label: "深色" },
              { value: "green", label: "墨绿" },
              { value: "warm", label: "暖白" },
              { value: "system", label: "跟随系统" },
            ]}
          />
        </Definition>
        <Definition term="默认阅读字号" description="阅读页可临时调整。">
          <Select
            label="默认阅读字号"
            value={font}
            onChange={(value) => {
              setFont(value);
              preferences.write("sciretriever:reading:font:v1", value);
            }}
            options={[18, 20, 22, 24].map((value) => ({
              value: String(value),
              label: `${value} px`,
            }))}
          />
        </Definition>
        <Definition term="默认阅读行宽">
          <Select
            label="默认阅读行宽"
            value={width}
            onChange={(value) => {
              setWidth(value);
              preferences.write("sciretriever:reading:width:v1", value);
            }}
            options={[
              { value: "comfortable", label: "舒适" },
              { value: "wide", label: "宽" },
              { value: "full", label: "全宽" },
            ]}
          />
        </Definition>
        <Definition term="动效" description="系统的“减少动效”设置同样生效。">
          <Select
            label="动效"
            value={motion.preference}
            onChange={(value) => {
              const choice =
                value === "reduced"
                  ? "reduced"
                  : value === "full"
                    ? "full"
                    : "system";
              motion.setPreference(choice);
              preferences.write("sciretriever:motion:v1", choice);
            }}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "reduced", label: "减少动效" },
              { value: "full", label: "完整动效" },
            ]}
          />
        </Definition>
      </Definitions>
    </Section>
  );
}
function Probe({
  owner,
  target = null,
  image = false,
}: {
  owner: string;
  target?: string | null;
  image?: boolean;
}) {
  const api = useApi();
  const probe = useMutation({
    mutationFn: () =>
      api.request("/api/configuration/probe", { owner, target, image }),
  });
  return (
    <div className="configuration-probe">
      <Button
        variant="process"
        confirm={{
          title: "测试连接",
          description:
            "会使用当前已保存的配置和凭据访问外部服务，可能消耗模型额度。尚未保存的草稿不会参与测试。",
          confirmLabel: "确认测试",
        }}
        isPending={probe.isPending}
        onPress={() => probe.mutate()}
      >
        测试 {target ?? (owner === "parse" ? "Parse" : "Browser 模型")}
      </Button>
      {probe.isError && (
        <p role="alert">
          测试未完成：{errorMessage(probe.error)}。配置没有改变。
        </p>
      )}
      {probe.data && (
        <p role="status">
          测试结果：{str(record(probe.data.result, "probe").outcome)} ·{" "}
          {serviceMessage(str(record(probe.data.result, "probe").reason))}
        </p>
      )}
    </div>
  );
}
function Credential({
  baseline,
  onResult,
}: {
  baseline: string;
  onResult: (result: JsonRecord) => void;
}) {
  const api = useApi();
  const [namespace, setNamespace] = useState("model"),
    [target, setTarget] = useState(""),
    [message, setMessage] = useState("");
  const secret = useRef<HTMLInputElement>(null),
    busy = useRef(false);
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (busy.current) return;
    const value = secret.current?.value ?? "";
    if (secret.current) secret.current.value = "";
    if (!value || !target.trim()) {
      setMessage("请选择凭据类型，并填写目标与凭据值。");
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const edit =
        namespace === "source"
          ? {
              namespace,
              target: target.trim(),
              kind: "set",
              fields: { api_key: value },
            }
          : { namespace, target: target.trim(), kind: "set", value };
      const result = await api.request("/api/configuration/credential", {
        edit,
        baseline,
      });
      onResult(result);
      setMessage(
        "凭据已保存且不回显；已组装能力的下一次外部请求会重新核验授权。",
      );
    } catch (error) {
      setMessage(
        `凭据保存失败：${errorMessage(error)}。值已从页面清除，请重新输入。`,
      );
    } finally {
      busy.current = false;
      setPending(false);
      if (secret.current) secret.current.value = "";
    }
  };
  return (
    <Section
      title="凭据"
      description="凭据只在提交时传给服务端，不保存在界面状态或本机偏好中，保存后不回显。"
      action={
        <Button
          variant="primary"
          isPending={pending}
          onPress={() => void save()}
        >
          保存凭据
        </Button>
      }
    >
      <Definitions>
        <Definition term="凭据类型">
          <Select
            label="凭据类型"
            value={namespace}
            onChange={setNamespace}
            options={[
              { value: "model", label: "模型 Provider" },
              { value: "source", label: "文献来源 API key" },
              { value: "mineru", label: "MinerU bearer token" },
            ]}
          />
        </Definition>
        <Definition
          term="目标名称"
          description="Provider 名称、来源名称或 MinerU。"
        >
          <TextField label="目标名称" value={target} onChange={setTarget} />
        </Definition>
        <Definition term="凭据值">
          <span className="credential-field">
            <input
              ref={secret}
              aria-label="凭据值"
              type="password"
              autoComplete="new-password"
            />
          </span>
        </Definition>
      </Definitions>
      <p role="status">{message}</p>
    </Section>
  );
}
function Sources({
  configuration,
  onChange,
  onSave,
  pending,
  dirty,
}: {
  configuration: JsonRecord;
  onChange: (sources: JsonRecord) => void;
  onSave: () => void;
  pending: boolean;
  /** The save button exists only while the sources have unsaved edits. */
  dirty: boolean;
}) {
  const sources = record(configuration.sources, "sources"),
    metadata = record(sources.metadata, "metadata"),
    acquisition = record(sources.acquisition, "acquisition"),
    wos = metadata.web_of_science
      ? record(metadata.web_of_science, "Web of Science")
      : {};
  const update = (kind: string, key: string, value: unknown) =>
    onChange({
      ...sources,
      [kind]: { ...record(sources[kind], kind), [key]: value },
    });
  const [error, setError] = useState("");
  const validate = () => {
    if (!Number.isSafeInteger(metadata.limit) || Number(metadata.limit) < 1) {
      setError("结果上限需为正整数。");
      return;
    }
    const selected = (kind: JsonRecord, name: string) =>
      kind.mode === "custom" &&
      Array.isArray(kind.providers) &&
      kind.providers.includes(name);
    if (
      (wos.product ||
        wos.database ||
        wos.edition ||
        selected(metadata, "web-of-science")) &&
      (!wos.product || !wos.database)
    ) {
      setError("Web of Science 需要同时填写产品和数据库。");
      return;
    }
    if (
      selected(acquisition, "unpaywall") &&
      !str(
        acquisition.unpaywall
          ? record(acquisition.unpaywall, "unpaywall").contact_email
          : null,
      )
    ) {
      setError("选择 Unpaywall 时，请填写联系邮箱。");
      return;
    }
    setError("");
    onSave();
  };
  const sourceLabel = (name: string) => SOURCE_LABELS[name] ?? name;
  const choice = (kind: "metadata" | "acquisition") => {
    const config = record(sources[kind], kind),
      selected = Array.isArray(config.providers)
        ? config.providers.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    return (
      <Definition
        term="来源"
        description={
          kind === "metadata"
            ? "自定义时只查询勾选的来源。"
            : "自定义时只尝试勾选的来源。"
        }
        value={
          config.mode === "custom"
            ? selected.length
              ? `已选 ${selected.length} 个：${selected.map(sourceLabel).join("、")}`
              : "尚未勾选来源"
            : "由应用按当前版本选择"
        }
      >
        <RadioGroup
          segmented
          label={kind === "metadata" ? "元数据来源模式" : "获取来源模式"}
          value={str(config.mode)}
          onChange={(mode) =>
            onChange({
              ...sources,
              [kind]: {
                ...config,
                mode,
                providers: mode === "auto" ? [] : selected,
              },
            })
          }
        >
          <Radio value="auto">自动</Radio>
          <Radio value="custom">自定义</Radio>
        </RadioGroup>
        {config.mode === "custom" ? (
          <div className="source-options">
            {[...new Set([...selected, ...SOURCE_PROVIDERS[kind]])].map(
              (name) => (
                <Checkbox
                  key={name}
                  label={sourceLabel(name)}
                  isSelected={selected.includes(name)}
                  onChange={(checked) =>
                    update(
                      kind,
                      "providers",
                      checked
                        ? [...selected, name]
                        : selected.filter((value) => value !== name),
                    )
                  }
                />
              ),
            )}
          </div>
        ) : null}
      </Definition>
    );
  };
  return (
    <div className="settings-sources">
      <Section
        title="元数据"
        description="导入书目、补全题录信息时查询的服务。"
      >
        <Definitions>
          {choice("metadata")}
          <Definition
            term="单次结果上限"
            description="每个来源一次查询最多返回的条数。"
          >
            <div className="settings-short-field">
              <TextField
                label="元数据结果上限"
                value={String(metadata.limit ?? 500)}
                onChange={(value) => update("metadata", "limit", Number(value))}
              />
            </div>
          </Definition>
        </Definitions>
      </Section>
      <Section title="PDF 获取" description="获取全文 PDF 时依次尝试的服务。">
        <Definitions>
          {choice("acquisition")}
          <Definition
            term="Unpaywall 联系邮箱"
            description="勾选 Unpaywall 时必填，随请求发送给 Unpaywall。"
          >
            <TextField
              label="Unpaywall 联系邮箱"
              value={str(
                acquisition.unpaywall
                  ? record(acquisition.unpaywall, "unpaywall").contact_email
                  : null,
              )}
              onChange={(contact_email) =>
                update(
                  "acquisition",
                  "unpaywall",
                  contact_email ? { contact_email } : null,
                )
              }
            />
          </Definition>
        </Definitions>
      </Section>
      <Section
        title="Web of Science"
        description="需要机构订阅。产品与数据库都留空时不使用。"
      >
        <Definitions>
          <Definition term="产品">
            <Select
              label="产品"
              value={str(wos.product)}
              onChange={(product) =>
                update(
                  "metadata",
                  "web_of_science",
                  product ? { ...wos, product } : null,
                )
              }
              options={[
                { value: "", label: "未配置" },
                { value: "starter", label: "Starter" },
                { value: "expanded", label: "Expanded" },
              ]}
            />
          </Definition>
          <Definition term="数据库" description="例如 WOS。">
            <TextField
              label="数据库"
              value={str(wos.database)}
              onChange={(database) =>
                update("metadata", "web_of_science", { ...wos, database })
              }
            />
          </Definition>
          <Definition term="版本" description="可选。">
            <TextField
              label="版本"
              value={str(wos.edition)}
              onChange={(edition) =>
                update("metadata", "web_of_science", {
                  ...wos,
                  edition: edition || null,
                })
              }
            />
          </Definition>
        </Definitions>
      </Section>
      {error && <p role="alert">{error}</p>}
      {dirty ? (
        <div className="form-actions">
          <Button variant="primary" isPending={pending} onPress={validate}>
            保存来源配置
          </Button>
        </div>
      ) : null}
    </div>
  );
}
