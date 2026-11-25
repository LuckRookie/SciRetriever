import { probeReason } from "../../strings.js";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  PageNote,
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
import { preferences } from "../../data/preferences.js";
import { ThemePicker, ThemeTimeSelect } from "./ThemePicker.js";
import { useShell } from "../../shell/context.js";
import { useMotionPreference } from "../../motion/index.js";
import { readingFont } from "../reader/input/reading-font.js";
import {
  MEASURE_LABELS,
  readingLayout,
  type Measure,
} from "../reader/input/reading-layout.js";
import { TEXT_SCALE } from "../reader/input/scale.js";
import { record, type JsonRecord } from "../../data/wire.js";
import { copyText, randomId } from "../../../browser-platform.js";
import {
  errorMessage,
  fullTextStrings,
  translationLanguageName,
} from "../../strings.js";
import {
  MODEL_APIS,
  MODEL_REASONING,
  runtimeStatus,
} from "./configuration-data.js";
import { ApplyConfiguration } from "../sources/ApplyConfiguration.js";
import { SETTINGS_SECTIONS, settingsSection } from "./sections.js";
import { SecretField } from "./SecretField.js";
import { NetworkSettings, networkOf } from "./Network.js";
import { DeviceConnections } from "./Devices.js";
import {
  SourceDirectoryPanel,
  sourceDirectoryKey,
} from "../sources/SourceDirectory.js";
import "./settings.css";

const Maintenance = lazy(() => import("../maintenance/Maintenance.js"));
/**
 * Runtime settings saved field by field: each group is one block with its own
 * save, and a save publishes only that block's fields (page specs “设置”).
 */
const GROUPS = {
  roles: [
    ["analyze", "model"],
    ["proofread", "model"],
    ["tags", "model"],
    ["tags", "consolidation_model"],
    ["tags", "backfill_model"],
    ["browser", "model"],
  ],
  browser: [
    ["browser", "enabled"],
    ["browser", "profile"],
    ["browser", "model"],
  ],
  parser: [
    ["parsing", "base_url"],
    ["parsing", "connection_mode"],
    ["parsing", "model_identity"],
  ],
  params: [
    ["tags", "max_per_literature"],
    ["tags", "candidate_k"],
    ["tags", "backfill_batch"],
  ],
} as const satisfies Record<string, readonly (readonly [string, string])[]>;
type Group = keyof typeof GROUPS;
const RUNTIME_SECTIONS = ["browser", "parsing", "analyze", "tags", "proofread"];
const str = (value: unknown) => (typeof value === "string" ? value : "");
/** The network section saves its two halves separately; each has its own mark. */
const networkMarks = { proxy: "network-proxy", via_proxy: "network-routes" };
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
  const sectionTabs =
    api.kind === "workspace"
      ? SETTINGS_SECTIONS
      : SETTINGS_SECTIONS.filter(
          (tab) =>
            tab.id === "appearance" ||
            (api.kind === "maintenance" && tab.id === "advanced"),
        );
  // Addresses of the earlier sections (`setting=sources`, `cred`, …) land on
  // their new homes; the first section, 外观, is the default.
  const [section, setSection] = useState(() =>
      settingsSection(
        route.parameters.get("setting") ?? route.parameters.get("section"),
        sectionTabs.map((tab) => tab.id),
      ),
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
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  const savedNow = snapshot
    ? record(snapshot.configuration, "saved configuration")
    : null;
  /** A runtime group differs from what is saved: its block has unsaved edits. */
  const groupDirty = (group: Group) =>
    !!draft &&
    !!savedNow &&
    GROUPS[group].some(
      ([name, key]) =>
        JSON.stringify(record(draft[name], name)[key] ?? null) !==
        JSON.stringify(record(savedNow[name], name)[key] ?? null),
    );
  // Runtime sections are judged by their groups, so a saved group never
  // leaves a stale mark; the other sections by their marks.
  const unsaved =
    [...dirty].some((name) => !RUNTIME_SECTIONS.includes(name)) ||
    (Object.keys(GROUPS) as Group[]).some(groupDirty);
  const leaveDecision = useRef<((allow: boolean) => void) | null>(null);
  useEffect(() => {
    if (!unsaved) return;
    return registerNavigationGuard(
      () =>
        new Promise<boolean>((resolve) => {
          leaveDecision.current = resolve;
          setLeaveConfirm(true);
        }),
    );
  }, [unsaved]);
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
  // The source directory saves on its own and re-reads the configuration. Adopt
  // that newer revision and keep only what was edited here; a section edited
  // here and changed elsewhere keeps the old baseline, so saving reports it.
  const rebase = (value: JsonRecord) => {
    const saved = record(value.snapshot, "snapshot"),
      next = record(saved.configuration, "configuration"),
      before = record(snapshot!.configuration, "configuration");
    if (!dirty.size) return accept(value);
    const moved = Object.keys(next).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]),
    );
    if (moved.some((k) => dirty.has(k) && k !== "sources")) return;
    setSnapshot(saved);
    setDraft((current) => {
      if (!current) return structuredClone(next);
      const merged: JsonRecord = {};
      for (const k of Object.keys(next)) {
        if (!dirty.has(k)) merged[k] = structuredClone(next[k]);
        else if (k !== "sources") merged[k] = current[k];
        else {
          // This page edits only the result limit; the directory owns the rest.
          const sources = record(next.sources, "sources");
          merged.sources = {
            ...structuredClone(sources),
            metadata: {
              ...record(sources.metadata, "metadata"),
              limit: record(
                record(current.sources, "sources").metadata,
                "metadata",
              ).limit,
            },
          };
        }
      }
      return merged;
    });
    const rows = registry(next);
    if (!dirty.has("providers")) setProviders(rows.providers);
    if (!dirty.has("models")) setModels(rows.models);
    setRuntime(value);
  };
  // Only a fresh read counts: after this page publishes, the cached read is older.
  const onRead = useRef<(value: JsonRecord) => void>(() => {});
  onRead.current = (value) => {
    if (!snapshot) accept(value);
    else if (record(value.snapshot, "snapshot").revision !== snapshot.revision)
      rebase(value);
  };
  useEffect(() => {
    if (read.data) onRead.current(read.data);
  }, [read.data, read.dataUpdatedAt]);
  useEffect(() => {
    if (!unsaved) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [unsaved]);
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
      /** Draft marks this save settles; the sections themselves by default. */
      marks?: string[];
      /** A group save: only these fields were published; the rest keep the draft. */
      fields?: readonly (readonly [string, string])[];
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
      // A group save settles no section mark: its blocks compare with the save.
      const marks = variables.fields
        ? []
        : (variables.marks ?? variables.sections);
      setDraft((current) => {
        const next = { ...(current ?? config) };
        for (const name of variables.sections)
          next[name] =
            variables.fields && current
              ? {
                  ...record(current[name], name),
                  ...Object.fromEntries(
                    variables.fields
                      .filter(([section]) => section === name)
                      .map(([, key]) => [
                        key,
                        structuredClone(record(config[name], name)[key]),
                      ]),
                  ),
                }
              : structuredClone(config[name]);
        // The half of the network section that was not saved keeps its draft.
        if (current && variables.sections.includes("network"))
          for (const [field, part] of Object.entries(networkMarks))
            if (!marks.includes(part) && dirtyNow.current.has(part))
              next.network = {
                ...record(next.network, "network"),
                [field]: record(current.network, "network")[field],
              };
        return next;
      });
      if (variables.sections.includes("providers")) {
        const rows = registry(config);
        setProviders(rows.providers);
        setModels(rows.models);
      }
      setDirty((current) => {
        const left = new Set(
          [...current].filter((name) => !marks.includes(name)),
        );
        if (!Object.values(networkMarks).some((part) => left.has(part)))
          left.delete("network");
        return left;
      });
      const text = variables.sections.includes("paths")
        ? "数据库绑定已保存。当前进程继续使用启动时的数据库；重启服务后生效。已有数据没有移动。"
        : `${variables.sections.includes("sources") ? "来源配置" : variables.sections.includes("providers") ? "模型服务" : variables.sections.includes("network") ? "网络设置" : "运行配置"}已保存并重新读取。${result.application_restart_required === true ? "当前服务需重启后应用新配置。" : ""}`;
      setMessage(text);
      shell.notify(text);
      // The source directory saves against the newest revision too.
      void queries.invalidateQueries({ queryKey: sourceDirectoryKey });
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
  const save = (
    sections: string[],
    configuration = draft,
    marks?: string[],
  ) => {
    if (!configuration || guard.current) return;
    guard.current = true;
    setMessage("正在校验并保存…");
    publish.mutate({ sections, configuration, ...(marks ? { marks } : {}) });
  };
  const savedConfiguration = snapshot
    ? record(snapshot.configuration, "saved configuration")
    : null;
  /** Saves one half of the network section; the other keeps its saved value. */
  const saveNetwork = (field: keyof typeof networkMarks) => {
    if (!draft || !savedConfiguration) return;
    const current = networkOf(draft),
      next = { ...networkOf(savedConfiguration), [field]: current[field] };
    if (typeof next.proxy === "string") next.proxy = next.proxy.trim() || null;
    save(["network"], { ...draft, network: next }, [networkMarks[field]]);
  };
  /** A half edited back to its saved value is no longer an unsaved change. */
  const editNetwork = (field: keyof typeof networkMarks, value: unknown) => {
    setDraft((current) =>
      current
        ? { ...current, network: { ...networkOf(current), [field]: value } }
        : current,
    );
    // Lists compare as sets: unticking and ticking again restores the saved value.
    const canonical = (v: unknown) =>
      JSON.stringify(v, (_, x: unknown) =>
        Array.isArray(x) ? [...(x as string[])].sort() : x,
      );
    const same =
      canonical(value) === canonical(networkOf(savedConfiguration)[field]);
    setDirty((current) => {
      const next = new Set(current);
      if (same) next.delete(networkMarks[field]);
      else next.add(networkMarks[field]);
      if (Object.values(networkMarks).some((part) => next.has(part)))
        next.add("network");
      else next.delete("network");
      return next;
    });
  };
  const proxied = networkOf(savedConfiguration).via_proxy;
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
          throw new Error("每个模型服务都需要名称、协议和服务地址。");
        if (Object.hasOwn(nextProviders, row.name.trim()))
          throw new Error("模型服务名称重复。");
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
          throw new Error("每个模型需要已登记的模型服务和远程名称。");
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
            `当前保存的${role === "browser" ? "浏览器" : "分析"}配置仍引用这个模型，请先调整并保存角色绑定。`,
          );
        const ref = value(role, "model");
        if (ref && !Object.hasOwn(nextModels, String(ref)))
          throw new Error(`模型仍绑定 ${role}，请先保存新的角色绑定。`);
        if (
          role === "browser" &&
          ref &&
          record(nextModels[String(ref)], "model").image !== true
        )
          throw new Error("浏览器绑定需要支持图像的模型，请先调整绑定。");
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
  /**
   * A block's last row (page specs “设置”): its save at the bottom right, with
   * “有未保存的改动” beside it while there is something to save.
   */
  const saveFooter = (isDirty: boolean, label: string, onPress: () => void) => (
    <>
      {isDirty ? (
        <span className="ui-block-footer-note">有未保存的改动</span>
      ) : null}
      <Button
        variant={isDirty ? "primary" : "secondary"}
        isPending={isDirty && publish.isPending}
        disabledReason={isDirty ? undefined : "还没有改动"}
        onPress={onPress}
      >
        {label}
      </Button>
    </>
  );
  const saveButton = (
    names: string[],
    label: string,
    onPress: () => void = () => save(names),
  ) => saveFooter(changed(...names), label, onPress);
  /** Publishes only one group's fields; everything else keeps its saved value. */
  const saveGroup = (group: Group) => {
    if (!draft || !savedNow) return;
    const configuration = structuredClone(savedNow);
    for (const [name, key] of GROUPS[group])
      configuration[name] = {
        ...record(configuration[name], name),
        [key]: record(draft[name], name)[key] ?? null,
      };
    const sections = [...new Set(GROUPS[group].map(([name]) => name))];
    if (guard.current) return;
    guard.current = true;
    setMessage("正在校验并保存…");
    publish.mutate({ sections, configuration, fields: GROUPS[group] });
  };
  const groupFooter = (group: Group, label: string) =>
    saveFooter(groupDirty(group), label, () => saveGroup(group));
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
  const credentials = readiness.data?.credentials;
  /** Whether a key is saved for this service; the value itself never comes back. */
  const keySaved = (name: string) =>
    credentials?.models.some(
      (item) => item.target.toLowerCase() === name.trim().toLowerCase(),
    ) === true &&
    credentials.models.find(
      (item) => item.target.toLowerCase() === name.trim().toLowerCase(),
    )!.present;
  const savedProviders = savedNow
    ? record(savedNow.providers, "providers")
    : {};
  const onCredential = (result: JsonRecord) => {
    setRuntime(result);
    void readiness.refetch();
  };
  const updateModel = (id: string, patch: Partial<ModelRow>) => {
    setModels(
      models.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    mark("models");
  };
  const providerBlock = (row: ProviderRow, index: number) => {
    const own = models
      .map((model, position) => ({ model, position }))
      .filter(({ model }) => model.provider === row.name);
    const stored =
      !!row.name.trim() &&
      Object.hasOwn(savedProviders, row.name.trim()) &&
      !changed("providers");
    return (
      <div
        className="settings-provider"
        key={row.id}
        role="group"
        aria-label={`模型服务 ${index + 1}`}
      >
        <h3>
          {row.name.trim() || `模型服务 ${index + 1}`}
          {proxied.providers.includes(row.name) ? (
            <span className="settings-egress">经代理</span>
          ) : null}
        </h3>
        <Definitions>
          <Definition
            term="名称"
            description="在模型选择和角色绑定里用这个名字指代它。"
          >
            <TextField
              label={`模型服务 ${index + 1} 名称`}
              value={row.name}
              onChange={(name) => {
                setProviders(
                  providers.map((item) =>
                    item.id === row.id ? { ...item, name } : item,
                  ),
                );
                // The service's models follow its new name.
                if (row.name)
                  setModels(
                    models.map((model) =>
                      model.provider === row.name
                        ? { ...model, provider: name }
                        : model,
                    ),
                  );
                mark("providers");
                mark("models");
              }}
            />
          </Definition>
          <Definition term="协议" description="服务使用的接口；要与服务一致。">
            <Select
              label={`模型服务 ${index + 1} 协议`}
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
          </Definition>
          <Definition
            term="地址"
            description="服务的 Base URL。密钥只发往这个地址。"
          >
            <TextField
              label={`模型服务 ${index + 1} 服务地址`}
              width="long"
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
          </Definition>
          <Definition term="密钥" description="保存后只显示“已保存”，不回显。">
            <SecretField
              label={`${row.name.trim() || `模型服务 ${index + 1}`} 的密钥`}
              saved={keySaved(row.name)}
              namespace="model"
              target={row.name.trim()}
              baseline={str(snapshot?.revision)}
              disabledReason={
                stored ? undefined : "先保存这个模型服务，再填密钥。"
              }
              onResult={onCredential}
            />
          </Definition>
          <Definition
            term="模型"
            description="这个服务上可用的模型：远程名称、推理强度与能力。"
          >
            <div className="settings-models">
              {own.map(({ model, position }) => (
                <div className="settings-model" key={model.id}>
                  <div className="settings-grid">
                    <TextField
                      label={`模型 ${position + 1} 远程名称`}
                      value={model.name}
                      onChange={(name) => updateModel(model.id, { name })}
                    />
                    <Select
                      label={`模型 ${position + 1} 推理强度`}
                      value={model.reasoning}
                      onChange={(reasoning) =>
                        updateModel(model.id, { reasoning })
                      }
                      options={MODEL_REASONING.map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                    <div className="settings-choices">
                      <Checkbox
                        label={`模型 ${position + 1} 支持图像`}
                        isSelected={model.image}
                        onChange={(image) => updateModel(model.id, { image })}
                      />
                      <Checkbox
                        label={`模型 ${position + 1} 流式输出`}
                        isSelected={model.stream}
                        onChange={(stream) => updateModel(model.id, { stream })}
                      />
                    </div>
                  </div>
                  <div className="settings-record-actions">
                    <Probe
                      owner="model"
                      target={`${model.provider}/${model.name}`}
                      image={model.image}
                    />
                    <Button
                      variant="text"
                      onPress={() => {
                        const ref = `${model.provider}/${model.name}`;
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
                          models.filter((item) => item.id !== model.id),
                        );
                        mark("models");
                      }}
                    >
                      移除模型
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                size="compact"
                isDisabled={!row.name.trim()}
                onPress={() => {
                  setModels([
                    ...models,
                    {
                      id: randomId(),
                      provider: row.name,
                      name: "",
                      reasoning: "default",
                      image: false,
                      stream: true,
                    },
                  ]);
                  mark("models");
                }}
              >
                添加模型
              </Button>
            </div>
          </Definition>
        </Definitions>
        <Button
          variant="text"
          onPress={() => {
            if (models.some((model) => model.provider === row.name)) {
              setMessage("这个模型服务仍有模型引用，请先移除或调整模型。");
              return;
            }
            setProviders(providers.filter((item) => item.id !== row.id));
            mark("providers");
          }}
        >
          移除模型服务
        </Button>
      </div>
    );
  };
  const rolesSection = (
    <Section
      title="角色绑定"
      description="每类工作用哪个模型。"
      footer={groupFooter("roles", "保存角色绑定")}
    >
      <Definitions>
        <Definition
          term="分析模型"
          description="单篇总结、补全书目与判断章节时使用；标签任务没有单独指定时也用它。"
        >
          <Select
            label="分析模型"
            value={str(value("analyze", "model"))}
            onChange={(value) => edit("analyze", "model", value || null)}
            options={modelOptions}
          />
        </Definition>
        <Definition
          term="校订矫正模型"
          description="逐页校订全文时使用，须支持图片与工具；不选则沿用分析模型。"
        >
          <Select
            label="校订矫正模型"
            value={str(value("proofread", "model"))}
            onChange={(v) => edit("proofread", "model", v || null)}
            options={modelOptions}
          />
        </Definition>
        {[
          ["model", "文献打标模型", "给每篇文献打标签；不选则沿用分析模型。"],
          ["consolidation_model", "词表整理模型", "合并、整理标签词表。"],
          ["backfill_model", "标签回溯模型", "给已有文献补打新加的标签。"],
        ].map(([key, label, description]) => (
          <Definition key={key} term={label!} description={description!}>
            <Select
              label={label!}
              value={str(value("tags", key!))}
              onChange={(v) => edit("tags", key!, v || null)}
              options={modelOptions}
            />
          </Definition>
        ))}
        <Definition
          term="浏览器模型"
          description="Browser Agent 看网页、找 PDF 时使用，须支持图像。"
        >
          <Select
            label="浏览器模型"
            value={str(value("browser", "model"))}
            onChange={(value) => edit("browser", "model", value || null)}
            options={modelOptions.map((option) => ({
              ...option,
              disabled:
                !!option.value &&
                record(record(draft?.models, "models")[option.value], "model")
                  .image !== true,
            }))}
          />
        </Definition>
      </Definitions>
    </Section>
  );
  return (
    <section className="settings-page">
      <PageHeader
        title="设置"
        action={api.kind === "workspace" ? <ApplyConfiguration /> : undefined}
      />
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置分区导航">
          <Tabs
            label="设置分区"
            orientation="vertical"
            value={section}
            onChange={setSection}
            items={[...sectionTabs]}
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
        <div className="settings-content" data-section={section}>
          {section === "appearance" ? (
            <Appearance />
          ) : section === "devices" ? (
            <DeviceConnections />
          ) : section === "advanced" ? (
            <>
              {api.kind === "workspace" ? (
                <Section title="配置">
                  <Definitions>
                    <Definition
                      term="重新读取配置"
                      description="从配置文件读回已保存的值；本页未保存的改动会被替换。"
                    >
                      <Button
                        isDisabled={publish.isPending}
                        onPress={() =>
                          unsaved ? setRefreshConfirm(true) : void refresh()
                        }
                      >
                        重新读取配置
                      </Button>
                    </Definition>
                  </Definitions>
                </Section>
              ) : null}
              <Suspense fallback={<p role="status">正在打开高级工具…</p>}>
                <Maintenance embedded />
              </Suspense>
            </>
          ) : read.isPending ? (
            <p role="status">正在读取配置…</p>
          ) : read.isError ? (
            <ErrorNotice message="配置读取失败，请重试。" onRetry={refresh} />
          ) : (
            draft && (
              <>
                {section === "models" && (
                  <>
                    <Section
                      title="模型服务"
                      description="每个服务一块：地址、密钥、模型与测试都在这里。"
                      footer={saveButton(
                        ["providers", "models"],
                        "保存模型服务",
                        saveModels,
                      )}
                    >
                      {providers.length ? null : (
                        <p className="settings-empty">还没有模型服务。</p>
                      )}
                      {providers.map(providerBlock)}
                      <div className="settings-provider-add">
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
                          添加模型服务
                        </Button>
                      </div>
                    </Section>
                    {rolesSection}
                  </>
                )}
                {section === "acquire" && (
                  <>
                    <Section title="文献来源">
                      <SourceDirectoryPanel />
                    </Section>
                    <Section
                      title="主题检索"
                      footer={saveButton(["sources"], "保存来源配置", () => {
                        const limit = Number(
                          record(
                            record(draft.sources, "sources").metadata,
                            "metadata",
                          ).limit,
                        );
                        if (!Number.isSafeInteger(limit) || limit < 1)
                          setMessage("结果上限需为正整数。");
                        else save(["sources"]);
                      })}
                    >
                      <Definitions>
                        <Definition
                          term="元数据结果上限"
                          description="每个来源每次检索最多读取的条数。调大找得更全，但更慢、更占来源的配额。"
                        >
                          <TextField
                            label="元数据结果上限"
                            width="short"
                            value={String(
                              record(
                                record(draft.sources, "sources").metadata,
                                "metadata",
                              ).limit ?? 500,
                            )}
                            onChange={(limit) => {
                              const sources = record(draft.sources, "sources");
                              setDraft({
                                ...draft,
                                sources: {
                                  ...sources,
                                  metadata: {
                                    ...record(sources.metadata, "metadata"),
                                    limit: Number(limit),
                                  },
                                },
                              });
                              mark("sources");
                            }}
                          />
                        </Definition>
                      </Definitions>
                    </Section>
                    <Section
                      title="受控浏览器"
                      description="自动途径拿不到 PDF 时，Browser Agent 用它打开出版社页面。"
                      footer={groupFooter("browser", "保存浏览器设置")}
                    >
                      <Definitions>
                        <Definition
                          term="启用浏览器"
                          description="关闭后获取 PDF 只走 API 与公开网站，不打开浏览器。"
                        >
                          <Switch
                            isSelected={value("browser", "enabled") === true}
                            onChange={(value) =>
                              edit("browser", "enabled", value)
                            }
                          >
                            启用浏览器
                          </Switch>
                        </Definition>
                        <Definition
                          term="浏览器个人资料"
                          description="浏览器保存登录与 Cookie 的目录；用已登录机构账号的资料能拿到更多全文。"
                        >
                          <TextField
                            label="浏览器个人资料"
                            width="long"
                            value={str(value("browser", "profile"))}
                            onChange={(value) =>
                              edit("browser", "profile", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="浏览器模型"
                          description="与“模型服务”里的角色绑定是同一项，须支持图像。"
                        >
                          <Select
                            label="浏览器模型"
                            value={str(value("browser", "model"))}
                            onChange={(value) =>
                              edit("browser", "model", value || null)
                            }
                            options={modelOptions}
                          />
                        </Definition>
                        <Definition
                          term="连接测试"
                          description="用已保存的配置和密钥试一次，可能消耗模型额度。"
                        >
                          <Probe owner="browser-model" image />
                        </Definition>
                      </Definitions>
                    </Section>
                  </>
                )}
                {section === "fulltext" && (
                  <>
                    <Section
                      title="解析服务"
                      description="MinerU 把 PDF 读成版面与文字，是解析全文的第一步。"
                      footer={groupFooter("parser", "保存解析服务")}
                    >
                      <Definitions>
                        <Definition
                          term="地址"
                          description="MinerU 服务的地址。"
                        >
                          <TextField
                            label="MinerU 服务地址"
                            width="long"
                            value={str(value("parsing", "base_url"))}
                            onChange={(value) =>
                              edit("parsing", "base_url", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="连接方式"
                          description="本机服务走 loopback；远程服务须用 HTTPS 并填访问令牌。"
                        >
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
                        <Definition
                          term="模型"
                          description="MinerU 使用的解析模型名称。"
                        >
                          <TextField
                            label="MinerU 模型"
                            value={str(value("parsing", "model_identity"))}
                            onChange={(value) =>
                              edit("parsing", "model_identity", value || null)
                            }
                          />
                        </Definition>
                        <Definition
                          term="访问令牌"
                          description="远程 MinerU 要求时填写；保存后只显示“已保存”，不回显。"
                        >
                          <SecretField
                            label="MinerU 访问令牌"
                            saved={credentials?.mineru === true}
                            namespace="mineru"
                            target="mineru"
                            baseline={str(snapshot?.revision)}
                            onResult={onCredential}
                          />
                        </Definition>
                        <Definition
                          term="连接测试"
                          description="用已保存的配置访问解析服务。"
                        >
                          <Probe owner="parse" />
                        </Definition>
                      </Definitions>
                    </Section>
                    <Section
                      title="参数"
                      footer={groupFooter("params", "保存解析全文的设置")}
                    >
                      {readiness.data?.diagnostics?.some(
                        (d) => d.code === "configuration-option-removed",
                      ) ? (
                        <PageNote>
                          配置文件里还有已删除的“每篇矫正调用上限”（
                          <code>proofread.max_calls_per_document</code>
                          ）。它不再生效：整理与校订在同一校验错误连续出现 3
                          次，或连续 8
                          次调用没有进展时停下。可以从配置文件中删去这一行。
                        </PageNote>
                      ) : null}
                      <Definitions>
                        {(
                          [
                            [
                              "max_per_literature",
                              "每篇标签上限",
                              1,
                              32,
                              "每篇文献最多打几个标签。调大标签更细，也更杂。",
                            ],
                            [
                              "candidate_k",
                              "候选检索数量",
                              1,
                              64,
                              "打标签前先从词表里挑出多少个候选。调大更不易漏，但每次调用更长、更贵。",
                            ],
                            [
                              "backfill_batch",
                              "回溯批量",
                              1,
                              64,
                              "补打新标签时一次处理几篇。调大更快完成，单次失败影响的篇数也更多。",
                            ],
                          ] as const
                        ).map(([key, label, min, max, description]) => (
                          <Definition
                            key={key}
                            term={label}
                            description={`${description}（${min}–${max}）`}
                          >
                            <NumberField
                              live
                              label={label}
                              minValue={min}
                              maxValue={max}
                              value={Number(value("tags", key) ?? min)}
                              onChange={(v) => edit("tags", key, v)}
                            />
                          </Definition>
                        ))}
                        <Definition
                          term="解析方式"
                          description="部署时选定的解析流程，只读。"
                        >
                          <span className="settings-readonly">
                            {str(value("parsing", "archive_profile")) ||
                              "vlm-engine"}
                          </span>
                        </Definition>
                      </Definitions>
                    </Section>
                    {/* Reading-experience 9: the language archiving translates
                        into; set in the configuration file only. */}
                    <Section
                      title={fullTextStrings.settingsTitle}
                      description={fullTextStrings.settingsDescription}
                    >
                      <Definitions>
                        <Definition
                          term={fullTextStrings.settingsLanguage}
                          description={fullTextStrings.settingsLanguageHelp}
                        >
                          <span className="settings-readonly">
                            {translationLanguageName(
                              str(
                                draft.translation &&
                                  typeof draft.translation === "object"
                                  ? value("translation", "target_language")
                                  : null,
                              ) || "zh-Hans",
                            )}
                          </span>
                        </Definition>
                      </Definitions>
                    </Section>
                  </>
                )}
                {section === "paths" && (
                  <Section
                    title="文献库文件"
                    description="改动后要重启服务才生效；已有文件不会移动。"
                    footer={saveButton(["paths"], "保存文献库位置")}
                  >
                    <Definitions>
                      <Definition
                        term="文献库文件"
                        description="保存书目、文件夹与任务记录的数据库文件。"
                        value={pathValue(api.workspace.catalog, "数据库路径")}
                      >
                        <TextField
                          label="文献库文件"
                          width="long"
                          value={str(value("paths", "catalog_path"))}
                          onChange={(value) =>
                            edit("paths", "catalog_path", value || null)
                          }
                        />
                      </Definition>
                      <Definition
                        term="文件存放位置"
                        description="PDF、解析材料与全文存放的目录。"
                        value={pathValue(
                          api.workspace.artifacts,
                          "文件存放位置",
                        )}
                      >
                        <TextField
                          label="文件存放位置"
                          width="long"
                          value={str(value("paths", "artifact_root"))}
                          onChange={(value) =>
                            edit("paths", "artifact_root", value || null)
                          }
                        />
                      </Definition>
                    </Definitions>
                  </Section>
                )}
                {section === "network" && savedConfiguration && (
                  <NetworkSettings
                    configuration={draft}
                    saved={savedConfiguration}
                    authentication={
                      readiness.data?.network?.proxy_authentication === true
                    }
                    baseline={str(snapshot?.revision)}
                    proxyAction={saveButton(
                      [networkMarks.proxy],
                      "保存代理",
                      () => saveNetwork("proxy"),
                    )}
                    routesAction={saveButton(
                      [networkMarks.via_proxy],
                      "保存走代理",
                      () => saveNetwork("via_proxy"),
                    )}
                    onProxy={(proxy) => editNetwork("proxy", proxy)}
                    onRoutes={(routes) => editNetwork("via_proxy", routes)}
                    onCredential={onCredential}
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
          <p role={publish.isError ? "alert" : "status"}>{message}</p>
          {snapshot && section !== "appearance" ? (
            <TechDetails>
              <p>
                配置版本：<code>{str(snapshot.revision)}</code>
              </p>
            </TechDetails>
          ) : null}
          {api.kind === "workspace" ? (
            // Signing out belongs to no section: the page's last line.
            <div className="settings-logout">
              <Button
                variant="text"
                onPress={() =>
                  void api
                    .logout()
                    .catch((error: unknown) => setMessage(errorMessage(error)))
                }
              >
                退出登录
              </Button>
              <span className="ui-description">
                释放当前浏览器连接；已提交的后台任务继续运行。
              </span>
            </div>
          ) : null}
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
  // The same one value as the reader's scale (reading-experience 4.5).
  const font = String(
      useSyncExternalStore(
        readingFont.subscribe,
        readingFont.get,
        readingFont.get,
      ),
    ),
    // The same one line length as the reader's “排版 → 行宽” (plan 25 block 30).
    lines = useSyncExternalStore(
      readingLayout.subscribe,
      readingLayout.get,
      readingLayout.get,
    );
  return (
    <Section
      title="外观与阅读"
      description="偏好保存在当前浏览器，不会更改文献库内容。"
    >
      <Definitions>
        <Definition term="主题">
          <ThemePicker />
        </Definition>
        {shell.theme === "system" ? (
          <>
            <Definition term="白天" description="系统为浅色时。">
              <ThemeTimeSelect time="day" />
            </Definition>
            <Definition term="夜里" description="系统为深色时。">
              <ThemeTimeSelect time="night" />
            </Definition>
          </>
        ) : null}
        <Definition term="默认阅读字号" description="阅读页可临时调整。">
          <Select
            label="默认阅读字号"
            value={font}
            onChange={(value) => readingFont.set(Number(value), "now")}
            options={Array.from(
              { length: TEXT_SCALE.max - TEXT_SCALE.min + 1 },
              (_, index) => TEXT_SCALE.min + index,
            ).map((value) => ({
              value: String(value),
              label: `${value} px`,
            }))}
          />
        </Definition>
        <Definition term="阅读行宽">
          <Select
            label="阅读行宽"
            value={lines.measure}
            onChange={(value) =>
              readingLayout.set({ measure: value as Measure })
            }
            options={(Object.keys(MEASURE_LABELS) as Measure[]).map(
              (value) => ({ value, label: MEASURE_LABELS[value] }),
            )}
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
          confirmLabel: "测试",
        }}
        isPending={probe.isPending}
        onPress={() => probe.mutate()}
      >
        测试 {target ?? (owner === "parse" ? "解析服务" : "浏览器模型")}
      </Button>
      {probe.isError && (
        <p role="alert">
          测试未完成：{errorMessage(probe.error)}。配置没有改变。
        </p>
      )}
      {probe.data && <ProbeResult value={probe.data.result} />}
    </div>
  );
}
function ProbeResult({ value }: { value: unknown }) {
  const result = record(value, "probe"),
    outcome = str(result.outcome),
    reason = str(result.reason);
  return (
    <p role="status" data-outcome={outcome}>
      {outcome === "passed"
        ? result.egress === "proxy"
          ? "测试通过，经代理连接正常。"
          : "测试通过，连接正常。"
        : `测试结果：${probeOutcomes[outcome] ?? outcome}。${reason ? probeReason(reason) : ""}`}
    </p>
  );
}
const probeOutcomes: Readonly<Record<string, string>> = {
  failed: "失败",
  blocked: "未执行",
  skipped: "已跳过",
  unavailable: "不可用",
};
