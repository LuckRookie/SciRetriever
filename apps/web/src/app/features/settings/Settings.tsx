import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseConfigurationReadiness } from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  PageHeader,
  Select,
  Tabs,
  TechDetails,
  TextField,
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
        errorMessage(error) === "configuration-conflict"
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
  return (
    <section className="settings-page">
      <PageHeader
        title="设置"
        description="管理当前文献库、服务与本机阅读偏好。"
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
      <Tabs
        label="设置分区"
        value={section}
        onChange={setSection}
        items={
          api.kind === "workspace"
            ? tabs
            : tabs.filter(
                (tab) =>
                  tab.id === "appearance" ||
                  (api.kind === "maintenance" && tab.id === "advanced"),
              )
        }
      />
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
              <div className="settings-section">
                <h2>文献库位置</h2>
                <p className="muted">
                  当前进程使用已绑定的位置。修改路径后重启生效，已有文件不会移动。
                </p>
                <TextField
                  label="Catalog 路径"
                  value={str(value("paths", "catalog_path"))}
                  onChange={(value) =>
                    edit("paths", "catalog_path", value || null)
                  }
                />
                <TextField
                  label="资产目录"
                  value={str(value("paths", "artifact_root"))}
                  onChange={(value) =>
                    edit("paths", "artifact_root", value || null)
                  }
                />
                <p>
                  当前进程：<code>{api.workspace.catalog ?? "未提供"}</code>
                </p>
                <p>
                  资产目录：<code>{api.workspace.artifacts ?? "未提供"}</code>
                </p>
                <div className="form-actions">
                  <Button
                    onPress={() =>
                      void copyText(api.workspace.catalog ?? "").then(() =>
                        shell.notify("数据库路径已复制"),
                      )
                    }
                  >
                    复制数据库路径
                  </Button>
                  <Button
                    variant="primary"
                    isPending={publish.isPending}
                    onPress={() => save(["paths"])}
                  >
                    保存文献库位置
                  </Button>
                </div>
                <h2>当前登录</h2>
                <p>退出会释放当前浏览器连接，已提交的后台任务继续运行。</p>
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
              </div>
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
              />
            )}
            {section === "models" && (
              <div className="settings-section">
                <h2>模型服务</h2>
                <p className="muted">
                  Provider 定义连接协议，Model
                  记录远程模型与能力。凭据在单独的分区保存。
                </p>
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
                              item.id === row.id ? { ...item, name } : item,
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
                              item.id === row.id ? { ...item, api } : item,
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
                              item.id === row.id ? { ...item, url } : item,
                            ),
                          );
                          mark("providers");
                        }}
                      />
                      <Button
                        variant="text"
                        onPress={() => {
                          if (
                            models.some((model) => model.provider === row.name)
                          ) {
                            setMessage(
                              "Provider 仍有模型引用，请先移除或调整模型。",
                            );
                            return;
                          }
                          setProviders(
                            providers.filter((item) => item.id !== row.id),
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
                <h2>已注册模型</h2>
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
                              item.id === row.id ? { ...item, provider } : item,
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
                              item.id === row.id ? { ...item, name } : item,
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
                              item.id === row.id ? { ...item, image } : item,
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
                              item.id === row.id ? { ...item, stream } : item,
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
                <div className="form-actions">
                  <Button
                    variant="primary"
                    isPending={publish.isPending}
                    onPress={saveModels}
                  >
                    保存 Provider/Model
                  </Button>
                </div>
                <h2>角色绑定</h2>
                <Select
                  label="分析模型"
                  value={str(value("analyze", "model"))}
                  onChange={(value) => edit("analyze", "model", value || null)}
                  options={modelOptions}
                />
                <Select
                  label="Browser 模型"
                  value={str(value("browser", "model"))}
                  onChange={(value) => edit("browser", "model", value || null)}
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
                <Button
                  variant="primary"
                  isPending={publish.isPending}
                  onPress={() => save(["browser", "parsing", "analyze"])}
                >
                  保存角色绑定
                </Button>
              </div>
            )}
            {section === "parser" && (
              <div className="settings-section">
                <h2>解析与 Browser</h2>
                <Checkbox
                  label="启用 Browser"
                  isSelected={value("browser", "enabled") === true}
                  onChange={(value) => edit("browser", "enabled", value)}
                />
                <TextField
                  label="Browser profile"
                  value={str(value("browser", "profile"))}
                  onChange={(value) =>
                    edit("browser", "profile", value || null)
                  }
                />
                <Select
                  label="Browser 模型"
                  value={str(value("browser", "model"))}
                  onChange={(value) => edit("browser", "model", value || null)}
                  options={modelOptions}
                />
                <TextField
                  label="MinerU 服务地址"
                  value={str(value("parsing", "base_url"))}
                  onChange={(value) =>
                    edit("parsing", "base_url", value || null)
                  }
                />
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
                <TextField
                  label="MinerU 模型"
                  value={str(value("parsing", "model_identity"))}
                  onChange={(value) =>
                    edit("parsing", "model_identity", value || null)
                  }
                />
                <div className="form-actions">
                  <Button
                    variant="primary"
                    isPending={publish.isPending}
                    onPress={() => save(["browser", "parsing", "analyze"])}
                  >
                    保存运行配置
                  </Button>
                </div>
                <Probe owner="parse" />
                <Probe owner="browser-model" image />
              </div>
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
              <div className="settings-section">
                <h2>运行状态</h2>
                <p data-state={runtimeNote.state}>{runtimeNote.message}</p>
                {readiness.isError ? (
                  <ErrorNotice
                    message="状态读取失败，已保存配置保持不变。"
                    onRetry={() => void readiness.refetch()}
                  />
                ) : (
                  <ul>
                    {readiness.data?.items.map((item) => (
                      <li key={`${item.owner}/${item.target}`}>
                        {item.owner} / {item.target}：{item.state} ·{" "}
                        {item.next_action}
                      </li>
                    ))}
                  </ul>
                )}
                <Button onPress={() => void readiness.refetch()}>
                  刷新状态
                </Button>
              </div>
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
    <div className="settings-section">
      <h2>外观与阅读</h2>
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
      <p className="muted">偏好保存在当前浏览器，不会更改文献库内容。</p>
    </div>
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
          {str(record(probe.data.result, "probe").reason)}
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
    <div className="settings-section">
      <h2>凭据</h2>
      <p>凭据只在提交时传给服务端，不保存在界面状态或本机偏好中。</p>
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
      <TextField label="目标名称" value={target} onChange={setTarget} />
      <label className="credential-field">
        凭据值
        <input ref={secret} type="password" autoComplete="new-password" />
      </label>
      <Button variant="primary" isPending={pending} onPress={() => void save()}>
        保存凭据
      </Button>
      <p role="status">{message}</p>
    </div>
  );
}
function Sources({
  configuration,
  onChange,
  onSave,
  pending,
}: {
  configuration: JsonRecord;
  onChange: (sources: JsonRecord) => void;
  onSave: () => void;
  pending: boolean;
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
  return (
    <div className="settings-section">
      <h2>文献来源</h2>
      {(["metadata", "acquisition"] as const).map((kind) => {
        const config = record(sources[kind], kind),
          selected = Array.isArray(config.providers)
            ? config.providers.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
        return (
          <fieldset key={kind}>
            <legend>
              {kind === "metadata" ? "元数据来源" : "PDF 获取来源"}
            </legend>
            <Select
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
              options={[
                { value: "auto", label: "自动" },
                { value: "custom", label: "自定义" },
              ]}
            />
            {config.mode === "custom" ? (
              <div className="source-options">
                {[...new Set([...selected, ...SOURCE_PROVIDERS[kind]])].map(
                  (name) => (
                    <Checkbox
                      key={name}
                      label={name}
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
            ) : (
              <p>自动来源由应用按当前版本选择。</p>
            )}
          </fieldset>
        );
      })}
      <TextField
        label="元数据结果上限"
        value={String(metadata.limit ?? 500)}
        onChange={(value) => update("metadata", "limit", Number(value))}
      />
      <h3>Web of Science</h3>
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
      <TextField
        label="数据库"
        value={str(wos.database)}
        onChange={(database) =>
          update("metadata", "web_of_science", { ...wos, database })
        }
      />
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
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <Button variant="primary" isPending={pending} onPress={validate}>
          保存来源配置
        </Button>
      </div>
    </div>
  );
}
