import {
  parseKnowledgeSynthesisRequest,
  parseStrictJsonValue,
  parseSynthesisExecutionReceipt,
  parseSynthesisListResult,
  parseSynthesisListSelection,
  parseSynthesisPreparationRequest,
  parseSynthesisPreparationResult,
  parseSynthesisReadResult,
  parseSynthesisReadSelection,
  parseSynthesisSourceResult,
  synthesisStatementSha256,
  type SynthesisEvidence,
  type SynthesisArtifact,
  type SynthesisInputManifest,
  type SynthesisPreparationResult,
  type SynthesisReadResult,
} from "@sciretriever/contracts";
import {
  post,
  verifiedEvidenceEntry,
  usesDurableTasks,
  submitProcessingTask,
} from "./knowledge.js";

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing synthesis element: ${id}`);
  return found as T;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
function number(id: string): number {
  return Number(node<HTMLInputElement>(id).value);
}
function line(
  parent: HTMLElement,
  tag: "p" | "h3" | "li",
  value: string,
): HTMLElement {
  const item = document.createElement(tag);
  item.textContent = value;
  parent.append(item);
  return item;
}
function live(parent: HTMLElement, signal: AbortSignal): boolean {
  return parent.isConnected && !signal.aborted;
}
function fixedInput(
  manifest: SynthesisInputManifest,
  support: SynthesisEvidence,
): SynthesisInputManifest["items"][number] {
  const item = manifest.items.find(
    (entry) => entry.input_id === support.input_id,
  );
  if (!item) throw new Error("来源未在固定集合中");
  if (support.target_kind === "knowledge") {
    if (
      item.kind !== "knowledge" ||
      item.source_artifact_id !== support.source_artifact_id ||
      item.source_content_sha256 !== support.source_content_sha256 ||
      item.source_manifest_sha256 === null ||
      item.compression_depth === null
    )
      throw new Error("来源与固定集合不一致");
  } else if (
    item.kind !== "document" ||
    !item.document ||
    !item.material ||
    item.document.document_version_id !==
      support.evidence.document_version_id ||
    item.document.representation_sha256 !==
      support.evidence.representation_sha256
  )
    throw new Error("文档证据与固定集合不一致");
  return item;
}
function showDocumentEvidence(
  parent: HTMLElement,
  support: Extract<SynthesisEvidence, { target_kind: "document" }>,
  manifest: SynthesisInputManifest,
  signal: AbortSignal,
): void {
  const item = fixedInput(manifest, support);
  if (item.kind !== "document" || !item.material)
    throw new Error("文档来源无效");
  const evidence = document.createElement("ul");
  evidence.append(
    verifiedEvidenceEntry(
      support.evidence,
      {
        literature_id: item.literature_id,
        asset_id: item.material.asset_id,
        asset_sha256: item.material.asset_sha256,
      },
      signal,
    ),
  );
  parent.append(evidence);
}
function sourceButton(
  parent: HTMLElement,
  support: Extract<SynthesisEvidence, { target_kind: "knowledge" }>,
  manifest: SynthesisInputManifest,
  chain: ReadonlySet<string>,
  signal: AbortSignal,
): void {
  fixedInput(manifest, support);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = `核对来源 ${support.source_artifact_id} / ${support.statement_id}`;
  button.addEventListener("click", () => {
    if (!live(parent, signal)) return;
    button.disabled = true;
    void openSource(parent, support, manifest, chain, signal)
      .then(() => {
        if (live(parent, signal)) button.remove();
      })
      .catch((error: unknown) => {
        if (live(parent, signal))
          line(parent, "p", `来源读取失败：${message(error)}`);
      })
      .finally(() => {
        if (live(parent, signal)) button.disabled = false;
      });
  });
  parent.append(button);
}
async function openSource(
  parent: HTMLElement,
  support: Extract<SynthesisEvidence, { target_kind: "knowledge" }>,
  manifest: SynthesisInputManifest,
  chain: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const item = fixedInput(manifest, support);
  if (item.kind !== "knowledge") throw new Error("来源无效");
  if (chain.has(support.source_artifact_id) || chain.size >= 32)
    throw new Error("来源链发生循环或超过层级上限");
  const selection = parseSynthesisReadSelection({
    artifact_id: support.source_artifact_id,
  });
  const response = await parseSynthesisSourceResult(
    await post("synthesis-source", selection, signal),
    selection,
  );
  if (!live(parent, signal)) return;
  const source = response.artifact;
  if (
    source.content_ref.sha256 !== support.source_content_sha256 ||
    source.input.manifest_sha256 !== item.source_manifest_sha256 ||
    (source.schema_version === 1 ? 1 : source.compression_depth) !==
      item.compression_depth
  )
    throw new Error("来源内容或固定清单不匹配");
  const matches = source.content.statements.filter(
    (entry) => entry.statement_id === support.statement_id,
  );
  if (
    matches.length !== 1 ||
    (await synthesisStatementSha256(matches[0])) !== support.statement_sha256
  )
    throw new Error("来源断言内容不匹配");
  if (!live(parent, signal)) return;
  const statement = matches[0]!;
  const detail = document.createElement("section");
  line(
    detail,
    "p",
    `来源 ${source.artifact_id} · 当前 ${response.state} · ${source.content.title}`,
  );
  line(detail, "p", statement.text);
  if (response.state === "source-only")
    line(
      detail,
      "p",
      "原 PDF 当前无法复核；以下仅核对已存知识断言及派生证据。",
    );
  if (source.schema_version === 1) {
    const input = source.input.items[0];
    if (!input?.material) throw new Error("知识来源未固定原文材料");
    const evidence = document.createElement("ul");
    const original = source.content.statements.find(
      (entry) => entry.statement_id === support.statement_id,
    )!;
    for (const ref of original.evidence)
      evidence.append(
        verifiedEvidenceEntry(
          ref,
          {
            literature_id: input.literature_id,
            asset_id: input.material.asset_id,
            asset_sha256: input.material.asset_sha256,
          },
          signal,
        ),
      );
    detail.append(evidence);
  } else {
    const nextChain = new Set([...chain, support.source_artifact_id]);
    const original = source.content.statements.find(
      (entry) => entry.statement_id === support.statement_id,
    )!;
    for (const ref of original.evidence) {
      if (ref.target_kind === "document")
        showDocumentEvidence(detail, ref, source.input, signal);
      else sourceButton(detail, ref, source.input, nextChain, signal);
    }
  }
  if (live(parent, signal)) parent.append(detail);
}
function render(
  result: SynthesisReadResult,
  target: HTMLElement,
  signal: AbortSignal,
): void {
  target.replaceChildren();
  const { artifact, current_source_states: states } = result;
  line(target, "h3", `${artifact.content.title} · ${artifact.artifact_id}`);
  line(target, "p", `问题：${artifact.question}`);
  line(
    target,
    "p",
    `覆盖：${artifact.coverage.status} · ${artifact.coverage.policy} · 实际独立支持文献 ${result.independent_literature_ids.length} 篇 · 压缩层级 ${artifact.compression_depth}`,
  );
  const coverage = document.createElement("ul");
  for (const [index, item] of artifact.coverage.items.entries()) {
    const input = artifact.input.items[index];
    const state =
      input?.input_id === item.input_id ? states[index]?.state : "unknown";
    const availability =
      item.status === "excluded"
        ? "本次未纳入／无固定引用，未查询当前可用性"
        : state === "source-only"
          ? "source-only：仅已存来源可核对，原 PDF 未复核"
          : `当前来源 ${state}`;
    line(
      coverage,
      "li",
      `${item.input_id}: ${item.status}${item.reason ? ` (${item.reason})` : ""} · ${availability}`,
    );
  }
  target.append(coverage);
  for (const statement of artifact.content.statements) {
    const section = document.createElement("section");
    line(
      section,
      "h3",
      `${statement.relation}${statement.conflict_group_id ? ` · 分歧组 ${statement.conflict_group_id}` : ""}`,
    );
    line(section, "p", statement.text);
    line(
      section,
      "p",
      `类别：${statement.category} · ${statement.epistemic}${statement.conditions.length ? ` · 条件：${statement.conditions.join("；")}` : ""}${statement.quantity ? ` · 数量：${statement.quantity.value} ${statement.quantity.unit}` : ""}`,
    );
    const evidence = document.createElement("ul");
    for (const source of statement.evidence) {
      const entry = document.createElement("li");
      line(
        entry,
        "p",
        `${source.input_id} · ${source.target_kind === "document" ? `文档 ${source.evidence.document_version_id}` : `知识断言 ${source.statement_id}`}`,
      );
      if (source.target_kind === "document")
        showDocumentEvidence(entry, source, artifact.input, signal);
      else
        sourceButton(
          entry,
          source,
          artifact.input,
          new Set([artifact.artifact_id]),
          signal,
        );
      evidence.append(entry);
    }
    section.append(evidence);
    target.append(section);
  }
}

/** Render one verified fixed synthesis statement, including its nested evidence controls. */
export function renderSynthesisSource(
  artifact: SynthesisArtifact,
  statementId: string,
  target: HTMLElement,
  signal: AbortSignal,
): void {
  target.replaceChildren();
  line(target, "h3", `${artifact.content.title} · ${artifact.artifact_id}`);
  const statement = artifact.content.statements.find(
    (entry) => entry.statement_id === statementId,
  );
  if (!statement) throw new Error("固定断言不存在");
  line(target, "p", statement.text);
  if (statement.conditions.length)
    line(target, "p", `条件：${statement.conditions.join("；")}`);
  if (statement.quantity)
    line(
      target,
      "p",
      `数量：${statement.quantity.value} ${statement.quantity.unit}${statement.quantity.comparison_basis ? ` · ${statement.quantity.comparison_basis}` : ""}`,
    );
  const evidence = document.createElement("ul");
  for (const support of statement.evidence) {
    const entry = document.createElement("li");
    line(
      entry,
      "p",
      `${support.input_id} · ${support.target_kind === "document" ? "文档证据" : "知识来源"}`,
    );
    if (support.target_kind === "document")
      showDocumentEvidence(entry, support, artifact.input, signal);
    else
      sourceButton(
        entry,
        support,
        artifact.input,
        new Set([artifact.artifact_id]),
        signal,
      );
    evidence.append(entry);
  }
  target.append(evidence);
}

export function mountSynthesisMaintenance(): void {
  const prepare = node<HTMLButtonElement>("synthesis-prepare");
  const start = node<HTMLButtonElement>("synthesis-start");
  const cancel = node<HTMLButtonElement>("synthesis-cancel");
  const inputs = node<HTMLTextAreaElement>("synthesis-inputs");
  const policy = node<HTMLSelectElement>("synthesis-policy");
  const question = node<HTMLTextAreaElement>("synthesis-question");
  const status = node("synthesis-status");
  const output = node("synthesis-result");
  let fixed: SynthesisPreparationResult | null = null;
  let fixedSignature = "";
  let active: AbortController | null = null;
  let generation = 0;
  const fields = [
    inputs,
    policy,
    question,
    ...[
      "synthesis-source-bytes",
      "synthesis-verification-bytes",
      "synthesis-call-bytes",
      "synthesis-total-call-bytes",
      "synthesis-max-calls",
      "synthesis-output-tokens",
      "synthesis-total-output-tokens",
    ].map((id) => node<HTMLInputElement>(id)),
  ];
  const signature = () => JSON.stringify([inputs.value, policy.value]);
  for (const field of [inputs, policy])
    field.addEventListener("input", () => {
      generation++;
      active?.abort();
      active = null;
      fixed = null;
      start.disabled = true;
      cancel.disabled = true;
      prepare.disabled = false;
      for (const control of fields) control.disabled = false;
      output.textContent = "";
      status.textContent = "选择已改变，请重新固定输入。";
    });
  window.addEventListener("pagehide", () => active?.abort());
  prepare.addEventListener("click", () => {
    const controller = new AbortController();
    active?.abort();
    active = controller;
    const current = ++generation;
    fixed = null;
    start.disabled = true;
    prepare.disabled = true;
    inputs.disabled = true;
    policy.disabled = true;
    status.textContent = "正在固定文档版本、知识产物和缺口…";
    output.textContent = "";
    void (async () => {
      const selection = parseSynthesisPreparationRequest({
        policy: policy.value,
        inputs: parseStrictJsonValue(inputs.value),
      });
      const prepared = await parseSynthesisPreparationResult(
        await post("synthesis-prepare", selection, controller.signal),
        selection,
      );
      if (current !== generation) return;
      fixed = prepared;
      fixedSignature = signature();
      start.disabled = !prepared.ready;
      status.textContent = prepared.ready
        ? `已固定 ${prepared.manifest.items.length} 项；${prepared.gaps.length} 项缺口。可启动综合。`
        : `集合未就绪：${prepared.gaps.map((gap) => `${gap.input_id}: ${gap.code}`).join("；")}`;
      output.textContent = JSON.stringify(prepared, null, 2);
    })()
      .catch((error: unknown) => {
        if (current === generation)
          status.textContent = `准备失败：${message(error)}`;
      })
      .finally(() => {
        if (current === generation) {
          prepare.disabled = false;
          inputs.disabled = false;
          policy.disabled = false;
          active = null;
        }
      });
  });
  cancel.addEventListener("click", () => {
    generation++;
    active?.abort();
    active = null;
    cancel.disabled = true;
    prepare.disabled = false;
    for (const field of fields) field.disabled = false;
    start.disabled = fixed === null || !fixed.ready;
    status.textContent = "请求已取消；已经提交的历史产物可在只读页按 ID 核对。";
  });
  start.addEventListener("click", () => {
    if (!fixed || !fixed.ready || fixedSignature !== signature() || active)
      return;
    const prepared = fixed;
    const controller = new AbortController();
    active = controller;
    const current = ++generation;
    prepare.disabled = true;
    start.disabled = true;
    cancel.disabled = false;
    for (const field of fields) field.disabled = true;
    status.textContent = "正在校验固定集合并执行有界综合…";
    output.textContent = "";
    void (async () => {
      const request = await parseKnowledgeSynthesisRequest({
        schema_version: 3,
        input: prepared.manifest,
        purpose: "synthesis",
        question: question.value,
        policy: prepared.policy,
        budget: {
          max_source_bytes: number("synthesis-source-bytes"),
          max_verification_bytes: number("synthesis-verification-bytes"),
          max_call_bytes: number("synthesis-call-bytes"),
          max_total_call_bytes: number("synthesis-total-call-bytes"),
          max_calls: number("synthesis-max-calls"),
          max_output_tokens_per_call: number("synthesis-output-tokens"),
          max_total_output_tokens: number("synthesis-total-output-tokens"),
        },
      });
      if (usesDurableTasks()) {
        await submitProcessingTask(
          { operation: "synthesize", request },
          status,
          controller.signal,
        );
        return;
      }
      const receipt = await parseSynthesisExecutionReceipt(
        await post("synthesize", request, controller.signal, true),
        request,
      );
      if (current !== generation) return;
      status.textContent =
        receipt.outcome === "blocked"
          ? `未发布：${receipt.gaps.map((gap) => `${gap.input_id}: ${gap.code}`).join("；")}`
          : `${receipt.published ? "已发布" : "已复用"} · ${receipt.artifact!.artifact_id} · ${receipt.artifact!.coverage.status} · ${receipt.artifact!.content.statements.length} 条断言。`;
      output.textContent = JSON.stringify(receipt, null, 2);
    })()
      .catch((error: unknown) => {
        if (current === generation)
          status.textContent = `综合失败：${message(error)}`;
      })
      .finally(() => {
        if (current === generation) {
          active = null;
          prepare.disabled = false;
          start.disabled = fixed === null || !fixed.ready;
          cancel.disabled = true;
          for (const field of fields) field.disabled = false;
        }
      });
  });
}

export function mountSynthesisReading(): void {
  const status = node("synthesis-read-status");
  const results = node("synthesis-read-results");
  const id = node<HTMLInputElement>("synthesis-read-id");
  let revision = 0;
  let active: AbortController | null = null;
  const begin = () => {
    ++revision;
    active?.abort();
    active = new AbortController();
    results.replaceChildren();
    return { current: revision, signal: active.signal };
  };
  const valid = (current: number, signal: AbortSignal) =>
    current === revision && !signal.aborted && results.isConnected;
  id.addEventListener("input", () => {
    begin();
    status.textContent = "Artifact ID 已更改，请重新读取。";
  });
  window.addEventListener("pagehide", () => {
    ++revision;
    active?.abort();
  });
  node<HTMLButtonElement>("synthesis-read-submit").addEventListener(
    "click",
    () => {
      const { current, signal } = begin();
      status.textContent = "正在核对综合产物与当前来源…";
      void (async () => {
        const selection = parseSynthesisReadSelection({
          artifact_id: id.value.trim(),
        });
        const result = await parseSynthesisReadResult(
          await post("synthesis-read", selection, signal),
          selection,
        );
        if (!valid(current, signal)) return;
        render(result, results, signal);
        status.textContent = `已核对 ${result.artifact.artifact_id}。`;
      })().catch((error: unknown) => {
        if (valid(current, signal))
          status.textContent = `读取失败：${message(error)}`;
      });
    },
  );
  node<HTMLButtonElement>("synthesis-list-submit").addEventListener(
    "click",
    () => {
      const { current, signal } = begin();
      status.textContent = "正在读取最近综合产物…";
      void (async () => {
        const selection = parseSynthesisListSelection({
          manifest_sha256: null,
          limit: 20,
        });
        const list = await parseSynthesisListResult(
          await post("synthesis-list", selection, signal),
          selection,
        );
        if (!valid(current, signal)) return;
        for (const result of list) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `${result.artifact.artifact_id} · ${result.artifact.question} · ${result.artifact.coverage.status}`;
          button.addEventListener("click", () => {
            const next = begin();
            id.value = result.artifact.artifact_id;
            render(result, results, next.signal);
            status.textContent = `已核对 ${result.artifact.artifact_id}。`;
          });
          results.append(button);
        }
        status.textContent = `找到 ${list.length} 项综合产物。`;
      })().catch((error: unknown) => {
        if (valid(current, signal))
          status.textContent = `列表读取失败：${message(error)}`;
      });
    },
  );
}
