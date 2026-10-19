import {
  parseProcessorBatchRequest,
  type ProcessorBatchRequest,
  type ProcessorObject,
} from "@sciretriever/contracts";
import { randomId } from "../../../browser-platform.js";
import type { ApiClient } from "../../data/api.js";
export interface FieldDraft {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  unit: string;
}
export interface Submission {
  fingerprint: string;
  request: ProcessorBatchRequest;
  jobId: string | null;
  started: boolean;
  note: string;
}
export interface FormDraft {
  kind: "records" | "labels";
  scope: "selection" | "query";
  meaning: string;
  inclusion: string;
  question: string;
  answerType: "boolean" | "string" | "enum";
  choices: string;
  reading: "full" | "search";
  readingQuery: string;
  fields: FieldDraft[];
  submission: Submission | null;
}
const drafts = new WeakMap<ApiClient, FormDraft>();
export function getDraft(api: ApiClient): FormDraft {
  let draft = drafts.get(api);
  if (!draft) {
    draft = {
      kind: "records",
      scope: "selection",
      meaning: "",
      inclusion: "",
      question: "",
      answerType: "boolean",
      choices: "",
      reading: "full",
      readingQuery: "",
      fields: [{ name: "", description: "", type: "string", unit: "" }],
      submission: null,
    };
    drafts.set(api, draft);
  }
  return draft;
}
export function saveDraft(api: ApiClient, draft: FormDraft) {
  drafts.set(api, draft);
}
export class FormProblem extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}
const fits = (text: string, bytes: number) =>
  new TextEncoder().encode(text).length <= bytes;
export function prepareSubmission(
  state: FormDraft,
  ids: readonly string[],
): Submission {
  const spec: ProcessorObject = {};
  if (state.kind === "records") {
    if (!state.meaning.trim() || !fits(state.meaning.trim(), 4096))
      throw new FormProblem("meaning", "请说明每条记录代表什么。");
    if (!fits(state.inclusion.trim(), 4096))
      throw new FormProblem("inclusion", "纳入条件过长，请缩短后重试。");
    if (!state.fields.length || state.fields.length > 64)
      throw new FormProblem("fields", "请添加 1–64 个字段。");
    const names = new Set<string>();
    for (const [index, field] of state.fields.entries()) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field.name) ||
        field.name.length > 64 ||
        names.has(field.name)
      )
        throw new FormProblem(
          `field-${index}-name`,
          "字段名以英文字母开头，可含数字和下划线；名称不能重复。",
        );
      if (!field.description.trim() || !fits(field.description.trim(), 2048))
        throw new FormProblem(
          `field-${index}-description`,
          "请填写简短的字段说明。",
        );
      if (field.type === "number" && !fits(field.unit.trim(), 128))
        throw new FormProblem(
          `field-${index}-unit`,
          "单位说明过长，请缩短后重试。",
        );
      names.add(field.name);
    }
    spec.record_meaning = state.meaning.trim();
    if (state.inclusion.trim()) spec.inclusion = state.inclusion.trim();
    spec.fields = state.fields.map((field) => ({
      name: field.name,
      description: field.description.trim(),
      type: field.type,
      unit:
        field.type === "number" && field.unit.trim() ? field.unit.trim() : null,
    }));
  } else {
    if (!state.question.trim() || !fits(state.question.trim(), 4096))
      throw new FormProblem("question", "请填写希望逐篇回答的问题。");
    spec.question = state.question.trim();
    spec.answer_type = state.answerType;
    if (state.answerType === "enum") {
      const choices = state.choices
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        choices.length < 1 ||
        choices.length > 64 ||
        choices.some((choice) => !fits(choice, 256)) ||
        new Set(choices).size !== choices.length
      )
        throw new FormProblem(
          "choices",
          "请填写 1–64 个简短且不重复的选项，每行一个。",
        );
      spec.choices = choices;
    }
  }
  if (
    state.reading === "search" &&
    (!state.readingQuery.trim() || !fits(state.readingQuery.trim(), 1024))
  )
    throw new FormProblem("readingQuery", "请填写用于选择片段的关键词。");
  spec.reading = {
    scope: state.reading,
    query: state.reading === "search" ? state.readingQuery.trim() : null,
  };
  const payload = {
    schema_version: 1,
    name:
      state.kind === "records"
        ? `记录提取 · ${state.meaning.trim().slice(0, 80)}`
        : `文献标签 · ${state.question.trim().slice(0, 80)}`,
    processor: { id: state.kind, version: "1" },
    spec,
    inputs: ids.map((id) => ({ kind: "literature", literature_id: id })),
  };
  const fingerprint = JSON.stringify(payload);
  if (state.submission?.fingerprint === fingerprint) return state.submission;
  return {
    fingerprint,
    request: parseProcessorBatchRequest({
      ...payload,
      idempotency_key: randomId(),
    }),
    jobId: null,
    started: false,
    note: "",
  };
}
export function processingError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    "processor-input-changed":
      "固定处理结果无法验证。来源引用与当前回执不一致，未使用其它结果替代。",
    "catalog-v10-required":
      "此文献库需要显式升级后才能使用处理器；已有文献仍可阅读。",
    "agent-role-unconfigured": "尚未配置分析模型，请在设置中配置后重启服务。",
    "agent-unconfigured": "尚未配置分析模型，请在设置中配置后重启服务。",
    "knowledge-unconfigured": "尚未配置分析模型，请在设置中配置后重启服务。",
    "agent-configuration": "分析模型配置不可用，请在设置中核对后重启服务。",
    "processor-unknown": "当前服务不支持所选处理器版本，请刷新后核对。",
    "processor-spec": "处理规范不受支持，请核对问题、字段类型与读取范围。",
    "processor-index-stale":
      "结果索引需要维护。已有结果仍保留；请通过 CLI/MCP 显式重建结果索引后重试，此页面不会自动重建。",
  };
  return (
    messages[code] ?? `操作未完成：${code}。草稿已保留，可重试或到任务页核对。`
  );
}
