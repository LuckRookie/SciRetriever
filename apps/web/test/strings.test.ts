import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readerErrorMessage } from "../src/reading/dom.js";
import {
  archiveReason,
  errorMessage,
  issueTitle,
  serviceMessage,
  statusLabels,
  valueCheckReason,
} from "../src/app/strings.js";
import { MATERIAL_STATES } from "../src/app/data/material-states.js";
import { taskStateLabel } from "../src/app/data/tasks.js";
it("localizes service diagnostics without exposing arbitrary English reasons", () => {
  expect(valueCheckReason("cited-value-missing")).toContain("所引的已校对片段");
  expect(
    valueCheckReason(
      "At least one cited number is absent from the corrected fragment.",
    ),
  ).toContain("对应原文");
  expect(errorMessage(new Error("Unexpected provider failure"))).not.toContain(
    "Unexpected provider failure",
  );
  expect(errorMessage(new Error("请填写字段说明。"))).toBe("请填写字段说明。");
  expect(serviceMessage("parser-unavailable")).toContain("解析服务");
  expect(serviceMessage("command-rejected")).toContain("任务操作未被接受");
  expect(errorMessage(new Error("contract validation failed"))).toContain(
    "无法通过验证",
  );
  expect(
    readerErrorMessage(new Error("正文尚未完整，缺少续读游标"), "无法读取正文"),
  ).toContain("缺少续读游标");
  expect(
    readerErrorMessage(
      new Error("Unexpected transport failure"),
      "无法读取正文",
    ),
  ).toBe("无法读取正文");
});

/** Strip comments, so only words that reach the screen are checked. */
function code(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, "")
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sources(path)
        : /\.tsx?$/u.test(entry.name)
          ? [path]
          : [];
    }),
  );
  return files.flat();
}

it("gives one meaning one word on screen (page specs “界面用词”)", async () => {
  // A paper's material, by what it has in hand.
  expect(
    Object.fromEntries(
      [
        "UNREVIEWED",
        "ASSET_READY",
        "READY",
        "ARCHIVING",
        "ARCHIVE_FAILED",
        "UNAVAILABLE",
        "EXCLUDED",
      ].map((state) => [state, statusLabels[state]]),
    ),
  ).toEqual({
    UNREVIEWED: "只有书目",
    ASSET_READY: "有 PDF",
    READY: "有全文",
    ARCHIVING: "正在解析全文",
    ARCHIVE_FAILED: "全文解析失败",
    UNAVAILABLE: "没找到 PDF",
    EXCLUDED: "已排除",
  });
  // The quick filters and the insights' categories take the same words.
  expect(
    MATERIAL_STATES.map((state) => [state.label, statusLabels[state.tone]]),
  ).toEqual(MATERIAL_STATES.map((state) => [state.label, state.label]));
  // A task's states; two codes of one meaning share its word.
  for (const [status, word] of [
    ["running", "进行中"],
    ["paused", "等你处理"],
    ["interrupted", "已中断"],
    ["failed", "失败"],
    ["completed", "已完成"],
    ["cancelled", "已取消"],
  ])
    expect(taskStateLabel({ status, start_requested: true })).toBe(word);
  expect(statusLabels.complete).toBe(statusLabels.completed);
  expect(statusLabels.pending).toBe(statusLabels.queued);
  expect(taskStateLabel({ status: "queued", start_requested: false })).toBe(
    "未启动",
  );
  expect(taskStateLabel({ status: "queued", start_requested: true })).toBe(
    "排队中",
  );
  // No page keeps an old word of the table, nor a second map for the same states.
  const old = [
    "建档",
    "建立文献档案",
    "已就绪",
    "仅元数据",
    "无法获取",
    "初稿",
    "校订稿",
    "文字层",
    "用当前结果",
    "书目待补",
    "等待执行",
    "执行中",
    "等待处理",
    "运行中断",
    "Catalog 路径",
    "资产目录",
  ];
  const found: string[] = [];
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  for (const file of await sources(root)) {
    const text = code(await readFile(file, "utf8"));
    for (const word of old)
      if (text.includes(word)) found.push(`${relative(root, file)}: ${word}`);
    if (
      !file.endsWith("strings.ts") &&
      /UNREVIEWED:\s*"[^"]*\p{Script=Han}/u.test(text) &&
      /READY:\s*"[^"]*\p{Script=Han}/u.test(text)
    )
      found.push(`${relative(root, file)}: a second status map`);
  }
  expect(found).toEqual([]);
});

it("names each 需处理 group by the problem, as a short phrase, never the code (plan 25 block 31.5)", () => {
  expect(archiveReason("parser-unavailable")).toBe("解析服务连不上");
  expect(archiveReason("metadata-incomplete")).toBe("书目缺少必填项");
  expect(archiveReason("tags-failed")).toBe("标签生成失败");
  expect(issueTitle("metadata-missing", "元数据")).toBe("书目缺少必填项");
  // A code without a phrase is named by the step that did not finish.
  expect(issueTitle("archive-step-failed", "整理")).toBe("“整理”没有完成");
  for (const code of [
    "needs-parse",
    "parse-failed",
    "proofread-incomplete",
    "correction-model-unconfigured",
    "model-failed",
    "render-failed",
    "manual-conflict",
  ]) {
    const title = archiveReason(code);
    // A phrase: no sentence punctuation, no advice, not the code.
    expect(title).not.toMatch(/[，。；]|请/u);
    expect(title).not.toContain(code);
    expect(title.length).toBeLessThanOrEqual(12);
  }
});
