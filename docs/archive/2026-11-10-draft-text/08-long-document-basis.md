# 08 · 长文档未逐页校订页的核对依据

类型：计划（结果块）
负责：长文档简化建档时，未逐页校订页上片段的核对依据改取初稿的三种取值
状态：Completed（2026-11-15）

## Outcome

- 新建档的长文档（ADR 0055）：
  - 未逐页校订（`unreviewed`）的页上，片段的 `basis` 取 `text-layer-match`、`text-layer-differs` 或 `no-text-layer`，与初稿用同一套对比规则；
  - 用“重试指定页”校订过的页，取校订稿的取值（`text-layer`、`image-only`、`manual`）；带人工文字锁的叶块取 `manual`；
  - 渲染使用 builder `source-order-leaves-v5`。
- 长文档的文本等级仍是校订稿，“长文档”标记与说明文字不变。
- 普通文献的校订稿完全不变。
- 已发布的长文档版本不重写、不重新发布，按记录的 builder 照旧重建。
- 长文档校订稿不保存差异记录，`draft-differences` 对它返回 `document-unsupported`。

规格：[04 §8.3](../../architecture/technical/04-document-evidence.md#83-初稿的结构与核对依据)“长文档”；[§6.3](../../architecture/technical/04-document-evidence.md#63-逐页校订与复用) 的长文档规则。

## 进入条件

02 的 2.1（取值类型）、2.4（对比函数）合入。不依赖 03–07。

## 责任边界

- 负责：后端实施者。
- 触达：
  - `apps/server/src/archive/text-pipeline.ts`（叶块 `basis` 现在只按页面类型取 `text-layer` 或 `image-only`）；
  - `packages/contracts` 中 `ArchiveTextBundleV2`、`DocumentStructureV2`、`archive-publication.ts` 对 `basis` 的解析；
  - `apps/server/src/archive/render.ts` 与 `apps/server/src/document/storage.ts`（新 builder `source-order-leaves-v5` 的渲染与校验分派）。
- 不改：长文档的判定、分段整理与断段；逐页校订请求；普通文献的任何输出字节。

## Tasks

- [x] **8.1 取值**：建档组装校订内容时（`text-pipeline.ts` 现在只按页面类型取 `text-layer` 或 `image-only`），对 `unreviewed` 页上的保留叶块调用 02 的对比函数，逐叶块取值，写进 `ArchiveTextBundleV2` 叶块的 `basis`（04 §8.3“长文档”）。页面分类与文字层取自建档来源，不另调用页面工具。
- [x] **8.2 合同**：校订内容与结构的 `basis` 解析扩为六种，三种初稿取值只允许出现在 `unreviewed` 页的叶块上；其余情形照旧拒绝。
- [x] **8.3 builder**：新增 `source-order-leaves-v5`：渲染与 v4 完全相同，只多接受三种取值；v4 遇到它们拒绝。长文档新形成的校订内容用 v5，普通文献继续用 v4。`document/storage.ts` 的 builder 分派加入 v5。
- [x] **8.4 对外读取**：segments、slice、evidence 返回这些取值；`processor-value-checks.ts` 已在 07 的 7.7 放宽。若本块先于 07 合入，在本块放宽该合同。

## 集成与影响

只影响本规则上线后新形成校订内容的长文档。正式库中的长文档数量很少（实际文献库完成建档的有 3 篇）。

## 验证

扩展 `archive-long-document.test.ts`（合成长文档），证明：

- 未校订页：文字与文字层一致的片段为 `text-layer-match`；故意改错的为 `text-layer-differs`；扫描页为 `no-text-layer`。
- 用 `retry_page_indexes` 校订的页：取 `text-layer` 或 `image-only`。
- 普通文献：校订内容与结构字节不变。
- 新建的长文档 builder 为 v5；已发布的 v4 长文档按 v4 重建，hash 不变，读取结果不变。
- v4 遇到初稿取值拒绝；对长文档校订稿调用 `draft-differences` 返回 `document-unsupported`（后者在 07 合入后验证）。

回归：`archive-long-document-production.test.ts`、`archive-render-v2.test.ts`；合同：`packages/contracts/test/long-document.test.ts`、`archive-text.test.ts`。

## 证据

提交号；定向测试结果。

## 退出条件

新建档的长文档在未校订页上带初稿的取值；普通文献不变。

## 恢复与交接

新 builder v5 与计划 19 正在改的渲染（`render.ts`）可能冲突，开工前与计划 19 的负责人确认顺序，记入本块。
