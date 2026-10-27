# 06 · 零散修复

类型：计划（结果块）
负责：P10、P11、P12
状态：Ready

## Outcome

1. 证据预览不再露出 LaTeX 原文，结果表里的长文本会换行。
2. 标题中的上下标按上下标显示。
3. 偶发失败的 Web 测试查清根因并修好，相关文件连续 5 次通过。

验收口径以问题清单 P10–P12 的“怎样检验”为准。

## 进入条件

无。可以立即开始。

## 责任边界

- Claude：P10、P11（前端）。
- worker：P12（测试稳定性）。
- P10 如需服务端改证据片段的格式，交 worker。

## Tasks

- [x] **6.1 证据预览与长文本**（Claude，P10）
  - 证据预览里的公式用现有 KaTeX 渲染，渲染失败时显示原文，不报错。
  - 结果表的长文本按单元格宽度换行。
  - 设计样例库加入含公式与长句的结果，在 1440 与 390 两种宽度下截图。
  - 2026-10-28 Claude 实现（`02c6e96`）：
    - 悬停预览把原文压成一段，用现有 KaTeX 行内渲染，`$$…$$` 改按行内；原始 HTML 照旧转义（`Evidence.tsx`）；
    - 结果表的取值按钮改为可换行，宽度上限 60ch，只在放不下时断词（`Results.tsx`、`processing.css`）；
    - 样例库的记录提取里，note 改为长取值、引用含公式的段落，并新增 `result-detail-peek-math` 页。
  - 截图：本机 `sandbox/reports/design-samples/2026-10-28-p17-06-final/`。
- [x] **6.2 标题上下标**（Claude，P11）
  - 标题中的 `<sub>`、`<sup>` 按受限白名单渲染，其他标签一律当文字处理。
  - 列表、阅读页、选择栏、页面标题都适用。
  - 样例库加含 `<sub>` 的标题，截图核对。
  - 2026-10-28 Claude 实现（`02c6e96`）：
    - 只读查看正式库后确认：标题里同时有原样的 `<sub>`、`<sup>`、`<i>`、`<scp>`，以及转义成 `&lt;sub&gt;` 的写法；
    - 新增 `apps/web/src/reading/title.ts`，先解码实体，再把白名单标签解析成文字片段，其余一律作文字处理；Crossref 在下标前补的空格去掉；
    - `paperTitle` 仍返回纯文本，供无障碍名称、标签页与排序使用；新增 `paperTitleParts` 与 `RichTitle`，用于文献库行与预览、阅读页、元数据来源、命令面板、检索分组、快照、任务逐篇经过、洞察；阅读引擎的标题也按片段渲染；
    - 样例 01、02 分别带原样与转义的标签；`design-samples.test.ts` 新增直接断言。
  - 验证：`pnpm quick` 通过；7 个相关 Web 测试文件 70 项通过，新增标题测试通过。
- [ ] **6.3 偶发失败的测试**（worker，P12）
  - 从各轮测试日志里收集偶发失败的用例（Agent 监控等），复现并查清根因，不靠放宽超时。
  - 修复后每个相关文件连续 5 次通过，记录命令与结果。
  - 已知一例（2026-10-28 Claude 核实）：`apps/server/test/document-read.test.ts` 的 “keeps unheaded text reachable and ignores late or mismatched browser read replies” 在干净的 HEAD（`bd1512e`）上也稳定失败。第三次 reload 后，错配提示要 1 秒以上才出现，而该处 poll 用的是默认超时；把它补到与前两处相同的 10 秒后，又在后面的 `delayed` poll 失败。要查清为什么 reload 后的读取变慢，不能只加超时。
  - 第二例（2026-10-28 Claude 核实）：`apps/web/test/next-reader-boundaries.test.ts` 的 “keeps encrypted PDF rejection at ingestion and reports no accepted PDF” 在 `7182549`（01 第三段之前）上同样失败。没有 PDF 时，“正在核对固定材料与文档版本…”一直不消失，与状态区同时存在，严格选择器取到两处。要查清读取为什么停在核对中，可能与第一例同源。

## 验证

- 6.1、6.2 的截图与 Web 测试；
- 6.3 的连续 5 次通过记录。

## 退出条件

6.1–6.3 合并，证据如上。

## 恢复与交接

6.3 中查明属于产品缺陷的，按 bug 修复，并补回归测试，在交接记录写明。
