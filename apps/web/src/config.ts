import { parseConfigurationReadiness } from "@sciretriever/contracts";
import { record, envelopeRecord, type JsonRecord } from "./wire.js";
import { onWorkspace } from "./navigation.js";

const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error("missing configuration element");
  return value as T;
};

function message(text: string): void {
  node("config-page-status").textContent = text;
}

const SOURCE_PROVIDERS = {
  metadata: [
    "web-of-science",
    "crossref",
    "semantic-scholar",
    "arxiv",
    "openalex",
    "europe-pmc",
    "elsevier",
    "springer",
    "datacite",
    "core",
    "opencitations",
  ],
  acquisition: [
    "arxiv",
    "crossref",
    "semantic-scholar",
    "openalex",
    "europe-pmc",
    "unpaywall",
    "elsevier",
    "springer",
    "wiley",
    "datacite",
    "core",
    "sci-hub",
  ],
} as const;

const MODEL_APIS = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
] as const;

const MODEL_REASONING = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function fillProviderOptions(
  kind: keyof typeof SOURCE_PROVIDERS,
  selected: readonly unknown[],
): void {
  const root = node(`config-${kind}-providers`);
  root.replaceChildren();
  const selectedNames = new Set(
    selected.filter((value): value is string => typeof value === "string"),
  );
  for (const provider of SOURCE_PROVIDERS[kind]) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = provider;
    input.checked = selectedNames.has(provider);
    input.disabled = true;
    const label = document.createElement("label");
    label.append(input, document.createTextNode(provider));
    root.append(label);
  }
}

function setSourceMode(kind: keyof typeof SOURCE_PROVIDERS): void {
  const custom =
    node<HTMLSelectElement>(`config-${kind}-mode`).value === "custom";
  node(`config-${kind}-provider-set`).hidden = !custom;
  node(`config-${kind}-auto`).hidden = custom;
  for (const input of node(
    `config-${kind}-providers`,
  ).querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    input.disabled = !custom;
}

function selectedProviders(
  kind: keyof typeof SOURCE_PROVIDERS,
  existing: readonly unknown[],
): string[] {
  const selected = new Set(
    [
      ...node(`config-${kind}-providers`).querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ]
      .filter((input) => input.checked)
      .map((input) => input.value),
  );
  const result: string[] = [];
  for (const provider of existing)
    if (typeof provider === "string" && selected.has(provider))
      result.push(provider);
  for (const provider of SOURCE_PROVIDERS[kind])
    if (selected.has(provider) && !result.includes(provider))
      result.push(provider);
  return result;
}

export function mountConfiguration(options: {
  read(path: string): Promise<JsonRecord>;
  request(path: string, body: unknown): Promise<JsonRecord>;
}): void {
  let snapshot: JsonRecord | null = null;
  let refreshRevision = 0;
  let readinessRevision = 0;
  let publishing = false;
  const publicationButtons = [
    "source-config-save",
    "provider-model-save",
    "config-save",
    "paths-config-save",
  ];
  const beginPublish = (): boolean => {
    if (publishing) {
      message("另一项配置正在保存，请稍候。");
      return false;
    }
    publishing = true;
    ++refreshRevision;
    for (const id of publicationButtons)
      node<HTMLButtonElement>(id).disabled = true;
    node<HTMLButtonElement>("config-refresh").disabled = true;
    return true;
  };
  const finishPublish = () => {
    publishing = false;
    for (const id of publicationButtons)
      node<HTMLButtonElement>(id).disabled = false;
    node<HTMLButtonElement>("config-refresh").disabled = false;
  };
  const renderReadiness = (value: unknown) => {
    const status = parseConfigurationReadiness(value);
    const root = node("config-readiness");
    root.replaceChildren();
    for (const item of status.items) {
      const row = document.createElement("li");
      row.textContent = `${item.owner}/${item.target}: ${item.state} · ${item.next_action}`;
      row.dataset.state = item.state;
      root.append(row);
    }
  };
  const renderRuntimeStatus = (value: JsonRecord) => {
    const root = node("config-runtime-status");
    const messages: string[] = [];
    const runtimeCapabilities =
      value.runtime_capabilities &&
      typeof value.runtime_capabilities === "object" &&
      !Array.isArray(value.runtime_capabilities)
        ? (value.runtime_capabilities as JsonRecord)
        : null;
    const parserRuntime =
      runtimeCapabilities?.parsing &&
      typeof runtimeCapabilities.parsing === "object" &&
      !Array.isArray(runtimeCapabilities.parsing)
        ? (runtimeCapabilities.parsing as JsonRecord)
        : null;
    const parserNeedsRestart =
      parserRuntime?.assembled === false &&
      parserRuntime.unavailable_reason === "startup-credential-missing";
    const reassemblySourceNames = (
      items: unknown,
      nameField: "provider_name" | "source_name",
    ): string[] =>
      Array.isArray(items)
        ? items.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
              return [];
            const item = value as JsonRecord;
            if (
              item.selected !== true ||
              item.assembled !== false ||
              (item.failure_code !== "credential-missing" &&
                item.failure_code !== "missing-credential")
            )
              return [];
            const name = item[nameField];
            return typeof name === "string" ? [name] : [];
          })
        : [];
    const unavailableSources = [
      ...reassemblySourceNames(runtimeCapabilities?.metadata, "provider_name"),
      ...reassemblySourceNames(runtimeCapabilities?.acquisition, "source_name"),
    ];
    const sourceNeedsRestart = unavailableSources.length > 0;
    const ordinaryConfigurationPending =
      value.ordinary_configuration_restart_required === true ||
      value.application_restart_reason === "ordinary-configuration" ||
      value.runtime_configuration_current === false;
    if (ordinaryConfigurationPending)
      messages.push(
        "普通配置已保存；当前 Application 的 Browser/Jobs 运行时仍使用启动时快照，需重启服务后生效。Probe 会读取已保存配置。",
      );
    else if (value.runtime_configuration_current === true)
      messages.push(
        "当前普通配置与 Application 启动快照一致。每次 Probe 都会读取最新配置和凭据。",
      );
    if (parserNeedsRestart)
      messages.push(
        "当前 Application 启动时缺少 MinerU 凭据，未组装 Parser。保存凭据后 Probe 可验证当前服务；实际解析需重启服务重新组装。",
      );
    else if (parserRuntime?.assembled === false)
      messages.push(
        parserRuntime.unavailable_reason === "configuration-incomplete"
          ? "当前 Application 启动时未组装 Parser；请补齐解析配置后重新检查。"
          : "当前 Application 未组装 Parser；请检查当前解析配置与服务状态。",
      );
    if (sourceNeedsRestart)
      messages.push(
        `当前 Application 启动时未能组装已选来源（${unavailableSources.join("、")}）。保存凭据后 Probe 会读取当前凭据；来源功能需重启服务后重新组装。`,
      );
    else if (runtimeCapabilities === null)
      messages.push(
        "当前 Application 的运行能力状态不可确认。Probe 仍读取当前保存配置。",
      );
    if (value.credential_effective_at === "next-external-request")
      messages.push(
        "凭据已保存；已组装能力的下一次外部请求会按当前文件重新核验，已进入传输的请求可结算。",
      );
    if (!messages.length)
      messages.push(
        "Probe 每次重新读取配置和凭据；当前 Application 运行快照状态不可确认。",
      );
    root.textContent = messages.join(" ");
    root.dataset.state =
      value.application_restart_required === true
        ? "restart-required"
        : value.application_restart_required === false
          ? "current"
          : "unknown";
  };
  const renderTaskModelOptions = (
    models: JsonRecord,
    analyzeValue: string,
    browserValue: string,
  ) => {
    const fill = (
      id: "config-analyze-model" | "config-browser-model",
      selected: string,
      eligible: (value: JsonRecord) => boolean,
    ) => {
      const select = node<HTMLSelectElement>(id);
      select.replaceChildren(new Option("未选择", ""));
      const references = Object.keys(models).sort();
      for (const reference of references) {
        const model = record(models[reference], "model configuration");
        if (eligible(model)) select.add(new Option(reference, reference));
      }
      if (
        selected &&
        ![...select.options].some((item) => item.value === selected)
      )
        select.add(new Option(`需调整：${selected}`, selected));
      select.value = selected;
    };
    fill("config-analyze-model", analyzeValue, () => true);
    fill("config-browser-model", browserValue, (model) => model.image === true);
  };

  const renderRuntimeControls = (configuration: JsonRecord) => {
    const browser = record(configuration.browser, "browser configuration");
    const parsing = record(configuration.parsing, "parsing configuration");
    const analyze = record(configuration.analyze, "analysis configuration");
    const models = record(configuration.models, "models configuration");
    node<HTMLInputElement>("config-browser-enabled").checked =
      browser.enabled === true;
    node<HTMLInputElement>("config-browser-profile").value =
      typeof browser.profile === "string" ? browser.profile : "";
    node<HTMLInputElement>("config-parser-url").value =
      typeof parsing.base_url === "string" ? parsing.base_url : "";
    node<HTMLSelectElement>("config-parser-mode").value =
      typeof parsing.connection_mode === "string"
        ? parsing.connection_mode
        : "";
    node<HTMLInputElement>("config-parser-model").value =
      typeof parsing.model_identity === "string" ? parsing.model_identity : "";
    renderTaskModelOptions(
      models,
      typeof analyze.model === "string" ? analyze.model : "",
      typeof browser.model === "string" ? browser.model : "",
    );
  };

  const renderSourceControls = (configuration: JsonRecord) => {
    const sources = record(configuration.sources, "sources configuration");
    const metadata = record(sources.metadata, "metadata sources");
    const acquisition = record(sources.acquisition, "acquisition sources");
    node<HTMLSelectElement>("config-metadata-mode").value =
      metadata.mode === "custom" ? "custom" : "auto";
    node<HTMLSelectElement>("config-acquisition-mode").value =
      acquisition.mode === "custom" ? "custom" : "auto";
    fillProviderOptions(
      "metadata",
      Array.isArray(metadata.providers) ? metadata.providers : [],
    );
    fillProviderOptions(
      "acquisition",
      Array.isArray(acquisition.providers) ? acquisition.providers : [],
    );
    node("config-metadata-auto").textContent =
      "Auto 来源由应用按当前版本选择。";
    node("config-acquisition-auto").textContent =
      "Auto 来源由应用按当前版本选择。";
    node<HTMLInputElement>("config-metadata-limit").value = String(
      typeof metadata.limit === "number" ? metadata.limit : 500,
    );
    const webOfScience =
      metadata.web_of_science &&
      typeof metadata.web_of_science === "object" &&
      !Array.isArray(metadata.web_of_science)
        ? (metadata.web_of_science as JsonRecord)
        : null;
    node<HTMLSelectElement>("config-wos-product").value =
      typeof webOfScience?.product === "string" ? webOfScience.product : "";
    node<HTMLInputElement>("config-wos-database").value =
      typeof webOfScience?.database === "string" ? webOfScience.database : "";
    node<HTMLInputElement>("config-wos-edition").value =
      typeof webOfScience?.edition === "string" ? webOfScience.edition : "";
    const unpaywall =
      acquisition.unpaywall &&
      typeof acquisition.unpaywall === "object" &&
      !Array.isArray(acquisition.unpaywall)
        ? (acquisition.unpaywall as JsonRecord)
        : null;
    node<HTMLInputElement>("config-unpaywall-contact").value =
      typeof unpaywall?.contact_email === "string"
        ? unpaywall.contact_email
        : "";
    setSourceMode("metadata");
    setSourceMode("acquisition");
  };

  const providerRows = node("provider-rows");
  const modelRows = node("model-rows");
  const providerNamesFromForm = (): string[] =>
    [...providerRows.querySelectorAll<HTMLInputElement>(".provider-name")]
      .map((input) => input.value.trim())
      .filter(Boolean);
  const modelValuesFromForm = (): JsonRecord => {
    const values: JsonRecord = {};
    for (const row of modelRows.querySelectorAll<HTMLElement>(".model-row")) {
      const provider =
        row.querySelector<HTMLSelectElement>(".model-provider")?.value;
      const name = row
        .querySelector<HTMLInputElement>(".model-name")
        ?.value.trim();
      if (!provider || !name) continue;
      const reasoning =
        row.querySelector<HTMLSelectElement>(".model-reasoning")?.value;
      const image =
        row.querySelector<HTMLInputElement>(".model-image")?.checked;
      const stream =
        row.querySelector<HTMLInputElement>(".model-stream")?.checked;
      values[`${provider}/${name}`] = {
        reasoning,
        image,
        stream,
      };
    }
    return values;
  };
  const updateModelProviderOptions = () => {
    const names = providerNamesFromForm();
    for (const select of modelRows.querySelectorAll<HTMLSelectElement>(
      ".model-provider",
    )) {
      const current = select.value;
      select.replaceChildren(new Option("选择 Provider", ""));
      for (const name of names) select.add(new Option(name, name));
      if (current && !names.includes(current))
        select.add(new Option(`未注册：${current}`, current));
      select.value = current;
    }
  };
  const updateTaskModelChoices = () => {
    const analyze = node<HTMLSelectElement>("config-analyze-model").value;
    const browser = node<HTMLSelectElement>("config-browser-model").value;
    renderTaskModelOptions(modelValuesFromForm(), analyze, browser);
  };
  const createField = (
    text: string,
    control: HTMLElement,
    className?: string,
  ): HTMLLabelElement => {
    const label = document.createElement("label");
    label.textContent = text;
    if (className) label.className = className;
    label.append(control);
    return label;
  };
  const makeSelect = (
    options: readonly { readonly value: string; readonly label: string }[],
    value: string,
    placeholder: string,
  ): HTMLSelectElement => {
    const select = document.createElement("select");
    select.add(new Option(placeholder, ""));
    for (const item of options) select.add(new Option(item.label, item.value));
    select.value = value;
    return select;
  };
  const createProviderRow = (
    name: string,
    provider: JsonRecord | null,
  ): HTMLElement => {
    const row = document.createElement("div");
    row.className = "registry-row provider-row";
    const nameInput = document.createElement("input");
    nameInput.className = "provider-name";
    nameInput.autocomplete = "off";
    nameInput.value = name;
    const api = makeSelect(
      MODEL_APIS,
      typeof provider?.api === "string" ? provider.api : "",
      "选择协议",
    );
    api.className = "provider-api";
    const baseUrl = document.createElement("input");
    baseUrl.className = "provider-base-url";
    baseUrl.type = "url";
    baseUrl.autocomplete = "off";
    baseUrl.value =
      typeof provider?.base_url === "string" ? provider.base_url : "";
    row.append(
      createField("Provider 名称", nameInput),
      createField("API 协议", api),
      createField("Base URL", baseUrl),
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除 Provider";
    remove.addEventListener("click", () => {
      const providerName = nameInput.value.trim();
      const hasModels = [
        ...modelRows.querySelectorAll<HTMLSelectElement>(".model-provider"),
      ].some((select) => select.value === providerName);
      const usedByTask = [
        node<HTMLSelectElement>("config-analyze-model").value,
        node<HTMLSelectElement>("config-browser-model").value,
      ].some((reference) => reference.startsWith(`${providerName}/`));
      if (providerName && (hasModels || usedByTask)) {
        message(
          "Provider 仍被 Model 或任务模型引用；先调整任务选择并删除/迁移关联 Model，再删除 Provider。",
        );
        return;
      }
      row.remove();
      updateModelProviderOptions();
      updateTaskModelChoices();
    });
    row.append(remove);
    nameInput.addEventListener("input", updateModelProviderOptions);
    nameInput.addEventListener("change", updateTaskModelChoices);
    return row;
  };
  const createModelRow = (
    reference: string,
    model: JsonRecord | null,
  ): HTMLElement => {
    const row = document.createElement("div");
    row.className = "registry-row model-row";
    const separator = reference.indexOf("/");
    const currentProvider = separator < 0 ? "" : reference.slice(0, separator);
    const currentName = separator < 0 ? "" : reference.slice(separator + 1);
    const provider = makeSelect(
      providerNamesFromForm().map((value) => ({ value, label: value })),
      currentProvider,
      "选择 Provider",
    );
    provider.className = "model-provider";
    if (currentProvider && !providerNamesFromForm().includes(currentProvider))
      provider.add(new Option(`未注册：${currentProvider}`, currentProvider));
    provider.value = currentProvider;
    const name = document.createElement("input");
    name.className = "model-name";
    name.autocomplete = "off";
    name.value = currentName;
    const reasoning = makeSelect(
      MODEL_REASONING.map((value) => ({ value, label: value })),
      typeof model?.reasoning === "string" ? model.reasoning : "default",
      "Reasoning",
    );
    reasoning.className = "model-reasoning";
    const image = document.createElement("input");
    image.className = "model-image";
    image.type = "checkbox";
    image.checked = model?.image === true;
    const stream = document.createElement("input");
    stream.className = "model-stream";
    stream.type = "checkbox";
    stream.checked = model?.stream !== false;
    row.append(
      createField("所属 Provider", provider),
      createField("Remote model 名称", name),
      createField("Reasoning", reasoning),
      createField("接受图片输入", image, "registry-flag"),
      createField("启用 Stream", stream, "registry-flag"),
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除 Model";
    remove.addEventListener("click", () => {
      const referenceValue =
        provider.value && name.value.trim()
          ? `${provider.value}/${name.value.trim()}`
          : "";
      const selected = [
        node<HTMLSelectElement>("config-analyze-model").value,
        node<HTMLSelectElement>("config-browser-model").value,
      ].includes(referenceValue);
      if (selected) {
        message(
          "Model 仍被 Analyze 或 Browser 选择；先调整并保存任务模型，再删除 Model。",
        );
        return;
      }
      row.remove();
      updateTaskModelChoices();
    });
    row.append(remove);
    provider.addEventListener("change", updateTaskModelChoices);
    name.addEventListener("input", updateTaskModelChoices);
    image.addEventListener("change", updateTaskModelChoices);
    return row;
  };
  const renderProviderModelRegistry = (
    configuration: JsonRecord,
    preserveTaskSelections = false,
  ) => {
    const previousAnalyze = preserveTaskSelections
      ? node<HTMLSelectElement>("config-analyze-model").value
      : "";
    const previousBrowser = preserveTaskSelections
      ? node<HTMLSelectElement>("config-browser-model").value
      : "";
    const providers = record(
      configuration.providers,
      "providers configuration",
    );
    const models = record(configuration.models, "models configuration");
    providerRows.replaceChildren();
    for (const [name, value] of Object.entries(providers))
      providerRows.append(
        createProviderRow(name, record(value, "provider configuration")),
      );
    modelRows.replaceChildren();
    for (const [reference, value] of Object.entries(models))
      modelRows.append(
        createModelRow(reference, record(value, "model configuration")),
      );
    updateModelProviderOptions();
    renderTaskModelOptions(
      models,
      preserveTaskSelections
        ? previousAnalyze
        : typeof record(configuration.analyze, "analysis configuration")
              .model === "string"
          ? (record(configuration.analyze, "analysis configuration")
              .model as string)
          : "",
      preserveTaskSelections
        ? previousBrowser
        : typeof record(configuration.browser, "browser configuration")
              .model === "string"
          ? (record(configuration.browser, "browser configuration")
              .model as string)
          : "",
    );
  };

  const renderSnapshot = (value: JsonRecord) => {
    snapshot = value;
    const configuration = record(value.configuration, "configuration");
    renderRuntimeControls(configuration);
    const paths = record(configuration.paths, "configuration paths");
    node<HTMLInputElement>("config-catalog-path").value =
      typeof paths.catalog_path === "string" ? paths.catalog_path : "";
    node<HTMLInputElement>("config-artifact-root").value =
      typeof paths.artifact_root === "string" ? paths.artifact_root : "";
    renderSourceControls(configuration);
    renderProviderModelRegistry(configuration);
  };
  const refreshReadiness = async () => {
    const revision = ++readinessRevision;
    const response = await options.read("/api/configuration/status");
    if (revision !== readinessRevision) return;
    renderReadiness(response.status);
  };
  const refreshReadinessAfterPublish = async (savedMessage: string) => {
    try {
      await refreshReadiness();
    } catch {
      message(
        `${savedMessage} 本次已保存，但 readiness 状态读取失败；点击刷新可重试状态读取。`,
      );
    }
  };
  const publishFailureMessage = (section: string, error: unknown): string => {
    const reason = error instanceof Error ? error.message : "command-rejected";
    if (reason === "configuration-conflict")
      return `${section}发布遇到 revision 冲突；草稿仍保留。请刷新当前保存值后再修正。`;
    if (reason === "configuration-invalid")
      return `${section}配置未通过 Owner 校验；草稿仍保留，请修正后重试。`;
    return `${section}发布结果未确认（${reason}）；草稿仍保留。请刷新查看当前保存值，确认前不要重复提交。`;
  };
  const refresh = async () => {
    if (publishing) return;
    const revision = ++refreshRevision;
    try {
      const [read, status] = await Promise.all([
        options.read("/api/configuration/read"),
        options.read("/api/configuration/status"),
      ]);
      if (revision !== refreshRevision) return;
      const next = envelopeRecord(read, "snapshot");
      renderSnapshot(next);
      renderRuntimeStatus(read);
      renderReadiness(status.status);
      message(`配置版本 ${String(next.revision)} · 草稿只在点击保存后提交`);
    } catch {
      if (revision !== refreshRevision) return;
      snapshot = null;
      message("配置读取失败；请检查本地服务后重试。");
    }
  };
  onWorkspace((workspace) => {
    if (workspace === "configuration" && snapshot === null) void refresh();
  });
  node("paths-config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot) {
      message("请先读取当前配置，再保存数据库绑定。");
      return;
    }
    if (!beginPublish()) return;
    const configuration = structuredClone(snapshot.configuration) as JsonRecord;
    configuration.paths = {
      ...record(configuration.paths, "configuration paths"),
      catalog_path:
        node<HTMLInputElement>("config-catalog-path").value.trim() || null,
      artifact_root:
        node<HTMLInputElement>("config-artifact-root").value.trim() || null,
    };
    const baseline =
      typeof snapshot.revision === "string" ? snapshot.revision : "";
    message("正在校验并保存数据库绑定…");
    void options
      .request("/api/configuration/publish-json", {
        configuration,
        baseline,
        sections: ["paths"],
      })
      .then((result) => {
        snapshot = envelopeRecord(result, "snapshot");
        renderRuntimeStatus(result);
        const savedMessage =
          "数据库绑定已保存。当前进程继续使用启动时的数据库；重启服务后生效。已有数据没有移动。";
        message(savedMessage);
        return refreshReadinessAfterPublish(savedMessage);
      })
      .catch((error: unknown) =>
        message(publishFailureMessage("数据库路径", error)),
      )
      .finally(finishPublish);
  });
  node("config-refresh").addEventListener("click", () => void refresh());
  for (const kind of ["metadata", "acquisition"] as const)
    node(`config-${kind}-mode`).addEventListener("change", () =>
      setSourceMode(kind),
    );
  node("provider-add").addEventListener("click", () => {
    providerRows.append(createProviderRow("", null));
  });
  node("model-add").addEventListener("click", () => {
    modelRows.append(createModelRow("", null));
    updateModelProviderOptions();
    updateTaskModelChoices();
  });
  node("source-config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot) {
      message("尚未读取配置，不能保存来源配置。");
      return;
    }
    const metadataMode = node<HTMLSelectElement>("config-metadata-mode").value;
    const acquisitionMode = node<HTMLSelectElement>(
      "config-acquisition-mode",
    ).value;
    const currentConfiguration = record(
      snapshot.configuration,
      "configuration",
    );
    const currentSources = record(
      currentConfiguration.sources,
      "sources configuration",
    );
    const currentMetadata = record(currentSources.metadata, "metadata sources");
    const currentAcquisition = record(
      currentSources.acquisition,
      "acquisition sources",
    );
    const metadataProviders = selectedProviders(
      "metadata",
      Array.isArray(currentMetadata.providers) ? currentMetadata.providers : [],
    );
    const acquisitionProviders = selectedProviders(
      "acquisition",
      Array.isArray(currentAcquisition.providers)
        ? currentAcquisition.providers
        : [],
    );
    const limit = node<HTMLInputElement>("config-metadata-limit").valueAsNumber;
    const product = node<HTMLSelectElement>("config-wos-product").value;
    const database = node<HTMLInputElement>("config-wos-database").value.trim();
    const edition = node<HTMLInputElement>("config-wos-edition").value.trim();
    const contactEmail = node<HTMLInputElement>(
      "config-unpaywall-contact",
    ).value.trim();
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (metadataMode !== "auto" && metadataMode !== "custom") ||
      (acquisitionMode !== "auto" && acquisitionMode !== "custom")
    ) {
      message("来源配置无效：结果上限需为正整数，并选择有效模式。");
      return;
    }
    const metadataSelection =
      metadataMode === "custom" ? metadataProviders : [];
    const acquisitionSelection =
      acquisitionMode === "custom" ? acquisitionProviders : [];
    const webOfScienceSelected = metadataSelection.includes("web-of-science");
    const unpaywallSelected = acquisitionSelection.includes("unpaywall");
    if ((product || database || edition) && (!product || !database)) {
      message("Web of Science 参数需要同时填写产品和数据库。");
      return;
    }
    if (webOfScienceSelected && (!product || !database)) {
      message("选择 Web of Science 时，请填写产品和数据库。");
      return;
    }
    if (unpaywallSelected && !contactEmail) {
      message("选择 Unpaywall 时，请填写联系邮箱。");
      return;
    }
    if (!beginPublish()) return;
    const configuration = structuredClone(snapshot.configuration) as JsonRecord;
    const sources = record(configuration.sources, "sources configuration");
    const metadata = record(sources.metadata, "metadata sources");
    const acquisition = record(sources.acquisition, "acquisition sources");
    metadata.mode = metadataMode;
    metadata.providers = metadataSelection;
    metadata.limit = limit;
    metadata.web_of_science = product
      ? {
          product,
          database,
          ...(edition ? { edition } : {}),
        }
      : null;
    acquisition.mode = acquisitionMode;
    acquisition.providers = acquisitionSelection;
    acquisition.unpaywall = contactEmail
      ? { contact_email: contactEmail }
      : null;
    const baseline =
      typeof snapshot.revision === "string" ? snapshot.revision : "";
    message("正在校验并保存来源配置…");
    void options
      .request("/api/configuration/publish-json", {
        configuration,
        baseline,
        sections: ["sources"],
      })
      .then((result) => {
        const next = envelopeRecord(result, "snapshot");
        snapshot = next;
        renderSourceControls(record(next.configuration, "configuration"));
        renderRuntimeStatus(result);
        const savedMessage =
          result.application_restart_required === true
            ? "来源配置已保存并重新读取；当前 Application 需重启后使用新配置。"
            : "来源配置已保存并重新读取。";
        message(savedMessage);
        return refreshReadinessAfterPublish(savedMessage);
      })
      .catch((error: unknown) => {
        message(publishFailureMessage("来源配置", error));
      })
      .finally(finishPublish);
  });
  node("provider-model-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot) {
      message("尚未读取配置，不能保存 Provider/Model 注册。");
      return;
    }
    const providers: JsonRecord = {};
    for (const row of providerRows.querySelectorAll<HTMLElement>(
      ".provider-row",
    )) {
      const name = row
        .querySelector<HTMLInputElement>(".provider-name")
        ?.value.trim();
      const api = row.querySelector<HTMLSelectElement>(".provider-api")?.value;
      const baseUrl = row
        .querySelector<HTMLInputElement>(".provider-base-url")
        ?.value.trim();
      if (!name || !api || !baseUrl) {
        message(
          "每个 Provider 都需要名称、受支持协议和 Base URL；移除空行或补齐字段。",
        );
        return;
      }
      if (Object.hasOwn(providers, name)) {
        message(`Provider 名称重复：${name}。请修正后再保存。`);
        return;
      }
      providers[name] = { api, base_url: baseUrl };
    }
    const models: JsonRecord = {};
    for (const row of modelRows.querySelectorAll<HTMLElement>(".model-row")) {
      const provider =
        row.querySelector<HTMLSelectElement>(".model-provider")?.value;
      const name = row
        .querySelector<HTMLInputElement>(".model-name")
        ?.value.trim();
      const reasoning =
        row.querySelector<HTMLSelectElement>(".model-reasoning")?.value;
      const image =
        row.querySelector<HTMLInputElement>(".model-image")?.checked;
      const stream =
        row.querySelector<HTMLInputElement>(".model-stream")?.checked;
      if (
        !provider ||
        !name ||
        !reasoning ||
        image === undefined ||
        stream === undefined
      ) {
        message(
          "每个 Model 都需要所属 Provider、远程名称、Reasoning 和能力选项；移除空行或补齐字段。",
        );
        return;
      }
      if (!Object.hasOwn(providers, provider)) {
        message(
          `Model 所属 Provider 尚未注册：${provider}。请调整 Model 或保留该 Provider。`,
        );
        return;
      }
      const reference = `${provider}/${name}`;
      if (Object.hasOwn(models, reference)) {
        message(`Model reference 重复：${reference}。请修正后再保存。`);
        return;
      }
      models[reference] = { reasoning, image, stream };
    }
    const savedConfiguration = record(snapshot.configuration, "configuration");
    const savedAnalyze = record(
      savedConfiguration.analyze,
      "analysis configuration",
    );
    const savedBrowser = record(
      savedConfiguration.browser,
      "browser configuration",
    );
    const analyzeReference =
      typeof savedAnalyze.model === "string" ? savedAnalyze.model : "";
    const browserReference =
      typeof savedBrowser.model === "string" ? savedBrowser.model : "";
    if (analyzeReference && !Object.hasOwn(models, analyzeReference)) {
      message(
        "当前保存的 Analyze 配置仍引用将被移除的 Model；先在运行配置中调整并保存 Analyze 模型，再删除该 Model。",
      );
      return;
    }
    if (browserReference && !Object.hasOwn(models, browserReference)) {
      message(
        "当前保存的 Browser 配置仍引用将被移除的 Model；先在运行配置中调整并保存 Browser 模型，再删除该 Model。",
      );
      return;
    }
    if (
      browserReference &&
      record(models[browserReference], "Browser model").image !== true
    ) {
      message(
        "Browser 模型必须接受图片输入；先调整并保存 Browser 模型，再更新 Model 能力。",
      );
      return;
    }
    if (!beginPublish()) return;
    const configuration = structuredClone(snapshot.configuration) as JsonRecord;
    configuration.providers = providers;
    configuration.models = models;
    const baseline =
      typeof snapshot.revision === "string" ? snapshot.revision : "";
    message("正在校验并保存 Provider/Model 注册…");
    void options
      .request("/api/configuration/publish-json", {
        configuration,
        baseline,
        sections: ["providers", "models"],
      })
      .then((result) => {
        const next = envelopeRecord(result, "snapshot");
        snapshot = next;
        renderProviderModelRegistry(
          record(next.configuration, "configuration"),
          true,
        );
        renderRuntimeStatus(result);
        const savedMessage =
          result.application_restart_required === true
            ? "Provider/Model 已保存并重新读取；当前 Application 需重启后使用新配置。"
            : "Provider/Model 已保存并重新读取。";
        message(savedMessage);
        return refreshReadinessAfterPublish(savedMessage);
      })
      .catch((error: unknown) =>
        message(publishFailureMessage("Provider/Model", error)),
      )
      .finally(finishPublish);
  });
  node("config-probe-parse").addEventListener("click", () => {
    node<HTMLButtonElement>("config-probe-parse").disabled = true;
    void options
      .request("/api/configuration/probe", {
        owner: "parse",
        target: null,
        image: false,
      })
      .then((result) => {
        const probe = record(result.result, "probe result");
        message(
          `Parse 测试：${String(probe.outcome)} · ${String(probe.reason ?? probe.execution ?? "")}`,
        );
        return refreshReadiness();
      })
      .catch(() => message("Parse 测试未完成；配置没有改变。"))
      .finally(() => {
        node<HTMLButtonElement>("config-probe-parse").disabled = false;
      });
  });
  node("config-probe-browser").addEventListener("click", () => {
    node<HTMLButtonElement>("config-probe-browser").disabled = true;
    void options
      .request("/api/configuration/probe", {
        owner: "browser-model",
        target: null,
        image: true,
      })
      .then((result) => {
        const probe = record(result.result, "probe result");
        message(
          `Browser 模型测试：${String(probe.outcome)} · ${String(probe.reason ?? "")}`,
        );
        return refreshReadiness();
      })
      .catch(() => message("Browser 模型测试未完成；配置没有改变。"))
      .finally(() => {
        node<HTMLButtonElement>("config-probe-browser").disabled = false;
      });
  });
  node("config-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot) {
      message("尚未读取配置，不能保存。");
      return;
    }
    if (!beginPublish()) return;
    const configuration = structuredClone(snapshot.configuration) as JsonRecord;
    const browser = record(configuration.browser, "browser configuration");
    const parsing = record(configuration.parsing, "parsing configuration");
    const analyze = record(configuration.analyze, "analysis configuration");
    browser.enabled = node<HTMLInputElement>("config-browser-enabled").checked;
    browser.model =
      node<HTMLSelectElement>("config-browser-model").value || null;
    browser.profile =
      node<HTMLInputElement>("config-browser-profile").value.trim() || null;
    parsing.base_url =
      node<HTMLInputElement>("config-parser-url").value.trim() || null;
    parsing.connection_mode =
      node<HTMLSelectElement>("config-parser-mode").value || null;
    parsing.model_identity =
      node<HTMLInputElement>("config-parser-model").value.trim() || null;
    analyze.model =
      node<HTMLSelectElement>("config-analyze-model").value || null;
    const baseline =
      typeof snapshot.revision === "string" ? snapshot.revision : "";
    message("正在校验并保存配置…");
    void options
      .request("/api/configuration/publish-json", {
        configuration,
        baseline,
        sections: ["browser", "parsing", "analyze"],
      })
      .then((result) => {
        const next = envelopeRecord(result, "snapshot");
        snapshot = next;
        renderRuntimeControls(record(next.configuration, "configuration"));
        renderRuntimeStatus(result);
        const savedMessage =
          result.application_restart_required === true
            ? "配置已保存并重新读取；当前 Application 需要重启后应用到 Browser/Jobs 操作。"
            : "配置已保存并重新读取；后续 Probe 使用当前保存版本。";
        message(savedMessage);
        return refreshReadinessAfterPublish(savedMessage);
      })
      .catch((error: unknown) => {
        message(publishFailureMessage("运行配置", error));
      })
      .finally(finishPublish);
  });
  node("config-credential-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const secret = node<HTMLInputElement>("config-credential-value");
    const target = node<HTMLInputElement>("config-credential-target");
    const namespace = node<HTMLSelectElement>(
      "config-credential-namespace",
    ).value;
    const value = secret.value;
    secret.value = "";
    if (!snapshot || !value || !target.value.trim()) {
      message("请选择凭据类型，并填写目标与凭据值。");
      return;
    }
    const baseline =
      typeof snapshot.revision === "string" ? snapshot.revision : "";
    const edit =
      namespace === "source"
        ? {
            namespace,
            target: target.value.trim(),
            kind: "set",
            fields: { api_key: value },
          }
        : {
            namespace,
            target: target.value.trim(),
            kind: "set",
            value,
          };
    const save = node<HTMLButtonElement>("config-credential-save");
    save.disabled = true;
    message("正在保存凭据；凭据值不会回显。");
    void options
      .request("/api/configuration/credential", { edit, baseline })
      .then((result) => {
        renderReadiness(result.status);
        renderRuntimeStatus(result);
        message(
          result.credential_effective_at === "next-external-request"
            ? "凭据已保存且不回显；下一次外部请求会重新核验授权，已在途请求可结算。"
            : "凭据已保存；页面只显示 presence readiness。",
        );
      })
      .catch((error: unknown) =>
        message(
          `凭据保存失败（${error instanceof Error ? error.message : "command-rejected"}）；值已从页面清除，请修正后重试。`,
        ),
      )
      .finally(() => {
        save.disabled = false;
        secret.value = "";
      });
  });
  void refresh();
}
