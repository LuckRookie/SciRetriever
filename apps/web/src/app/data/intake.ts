import { listField, record, stringField, type JsonRecord } from "./wire.js";

export interface IntakeReport {
  readonly raw: JsonRecord;
  readonly status: "completed" | "partial" | "failed";
  readonly label: string;
  readonly summary: string;
  readonly notices: readonly string[];
}

const rejectionReasons: Readonly<Record<string, string>> = {
  "input-too-large": "书目文件过大",
  "malformed-document": "无法解析书目文件",
  "empty-document": "文件中没有书目记录",
  "malformed-record": "记录格式不完整或无法解析",
  "identity-rejected": "未能确认文献身份",
  "identity-failed": "文献身份处理失败",
};

/** Project actual discovery/import receipts; never infer success from HTTP 200. */
export function readIntakeReport(value: unknown): IntakeReport {
  const raw = record(value, "intake report");
  if ("format" in raw) {
    const counts = { created: 0, enriched: 0, matched: 0, rejected: 0 };
    const notices: string[] = [];
    for (const value of listField(raw, "items")) {
      const item = record(value, "import item");
      const disposition = stringField(item, "disposition");
      if (!Object.hasOwn(counts, disposition))
        throw new Error("invalid import disposition");
      counts[disposition as keyof typeof counts]++;
      if (disposition === "rejected") {
        const index = count(item, "record_index");
        const reason = typeof item.reason === "string" ? item.reason : "";
        notices.push(
          `第 ${index + 1} 条：${rejectionReasons[reason] ?? "未能接纳，请核对书目信息后重试"}。`,
        );
      }
    }
    const accepted = counts.created + counts.enriched + counts.matched;
    const status = counts.rejected
      ? accepted > 0
        ? "partial"
        : "failed"
      : "completed";
    return {
      raw,
      status,
      label:
        status === "failed"
          ? "未导入"
          : status === "partial"
            ? "部分导入"
            : "导入完成",
      summary: `新增 ${counts.created} 篇 · 补充 ${counts.enriched} 篇 · 已存在 ${counts.matched} 篇 · 未接纳 ${counts.rejected} 条`,
      notices,
    };
  }
  const state = stringField(raw, "status");
  if (!["COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"].includes(state))
    throw new Error("invalid discovery status");
  const status =
    state === "COMPLETED"
      ? "completed"
      : state === "FAILED"
        ? "failed"
        : "partial";
  const notices: string[] = [];
  for (const value of listField(raw, "source_results")) {
    const source = record(value, "discovery source");
    const name = stringField(source, "provider_name");
    const outcome = stringField(source, "outcome");
    if (outcome === "FAILED" || source.failure)
      notices.push(`${name} 未完整返回结果，请检查来源状态后重试。`);
    else if (outcome === "SCAN_LIMIT_REACHED")
      notices.push(`${name} 已达到本次扫描上限，可调整范围后继续。`);
    else if (outcome !== "EXHAUSTED")
      throw new Error("invalid discovery source outcome");
  }
  if (state === "INTERRUPTED")
    notices.unshift("本次发现已中断，已接纳的文献仍然保留。");
  return {
    raw,
    status,
    label:
      state === "INTERRUPTED"
        ? "已中断"
        : state === "FAILED"
          ? "发现失败"
          : state === "PARTIAL"
            ? "部分完成"
            : "发现完成",
    summary:
      "accepted_count" in raw
        ? `已接纳 ${count(raw, "accepted_count")} 条元数据 · 匹配已有 ${count(raw, "matched_count")} 条`
        : `本次引用扩展得到 ${count(raw, "result_count")} 篇文献`,
    notices,
  };
}

function count(value: JsonRecord, key: string): number {
  const n = value[key];
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`invalid intake ${key}`);
  return n;
}
