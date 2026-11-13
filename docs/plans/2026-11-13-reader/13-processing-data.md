# 13 · 加工结果的读取层与合成结果

类型：计划（结果块）
负责：阅读页读取概览、脉络、回答与关联的唯一入口；能力报告；设计样例库与测试里的合成加工结果
状态：Pending

## Outcome

- 阅读页只通过一个读取层取得加工结果。读取层调用知识加工规格 8.12 的九个读取操作与 8.13 的能力报告，给视图的是阅读页自己的视图模型，规格第 7 节列出的每一项都有对应字段。
- 设计样例库与测试里有四份带合成加工结果的样例：研究论文、综述、人写的笔记、按章处理的长资料（学位论文）。合成结果按规格的响应格式给出。在计划 16 交付之前，14–17 就在它们上面实现和验收。
- 计划 16 的 14.9 交付后，读取层直接接上真实服务，视图不改。

规格：

- 阅读页依赖的数据：[阅读体验第 7 节](../../architecture/web/reading-experience.md#7-依赖的加工数据)；
- 读取操作：[知识加工 8.12](../../architecture/technical/05-knowledge-processing.md#812-视图机器读取与导出)“按资料的阅读读取”；入口与能力报告：[8.13](../../architecture/technical/05-knowledge-processing.md#813-版本迁移与机器接口)；
- HTTP：[统一产品接口 2.4](../../architecture/technical/01-product-interface.md#24-当前只读-api) 的 `POST /api/v1/query/material-reading` 与 `GET /api/v1/query/status`；
- 结果的格式：[知识加工 8.16](../../architecture/technical/05-knowledge-processing.md#816-阅读层概览与脉络)。

## 进入条件

R2 通过。

## 责任边界

- 负责：前端实施者。
- 拥有：读取层（建议 `apps/web/src/app/data/material-reading.ts`）与视图模型类型；合成结果夹具（建议 `apps/web/test/material-reading-fixture.ts`）。
- 触达：`apps/web/src/app/data/` 的查询键与失效规则（读取结果不随任务轮询重建引擎，见 03 的 3.5）；`apps/web/test/design-samples-pages.ts`。
- 不改：服务端；计划 16 的合同与响应格式（只读取，不定义）。
- 与计划 16 的 14.11（结果页里的概览视图与脉络视图）共用读取层与视图模型，不各写一份。

## Tasks

- [ ] **13.1 读取层与视图模型**
  - 九个读取操作各一个函数，请求与响应按规格 8.12 的表：

    | 操作                 | 阅读页的用途                                         | 由谁使用 |
    | -------------------- | ---------------------------------------------------- | -------- |
    | `material-layers`    | 当前的脉络与概览、按章模式、进行中的运行             | 14、17   |
    | `material-points`    | 脉络的要点与依据，分页                               | 14、17   |
    | `material-marks`     | 原文的要点标签、关键句、按问题阅读的“相关”段落，分页 | 14、15   |
    | `material-answers`   | 在这份资料上问过的问题                               | 15       |
    | `material-answer`    | 按结果或按问题文字取回答（规范化后完全相同匹配）     | 15       |
    | `answer-progress`    | 回答进行中的进度                                     | 15       |
    | `material-relations` | 引用数、按要点的关联                                 | 16       |
    | `material-topics`    | 所在主题页                                           | 16       |
    | `material-chapters`  | 长资料的章列表与各章状态                             | 17       |

  - 共同规则照规格：按 `literature_id` 与正在读的 `document_version_id` 寻址，长资料的一章加 `chapter_id`；列表按 `next_cursor` 续读，单个响应不超过 1 MiB；`ResultDescriptor` 的 `freshness`、`on_read_version`、`method_current` 都进视图模型；出处角标取响应里的 `mark`（`{paragraph, sentences}`，`sentences` 可以为 `null`），阅读页不自己分句。
  - 错误与空结果分开：资料没有某种结果时是 `null` 或空列表（视图显示第 3.9 节的状态）；能力不可用时是 `capability-unavailable`（视图不出现对应的入口）；`reading-target-mismatch`、`marks-version-mismatch` 按缺口显示，不当作“没有结果”。
  - 能力报告：读 `GET /api/v1/query/status` 的 `processing_capabilities`。`reading_layers.available` 决定“概览”“脉络”两格，`question_answering.available` 决定提问框，`relations.available` 决定关联标签页里按要点的部分（引用数始终显示）。读取失败时按“不可用”处理。`can_start` 的用法等 01 的 1.7。
  - 视图模型按规格第 7 节：共同部分、概览、脉络、回答、关联、长资料各一组类型。证据标记的数据等 01 的 1.8，阅读层运行的进度等 01 的 1.9。
  - 线上格式的类型来自 `packages/contracts`。计划 16 的 14.9 交付合同之前，线上格式暂按规格 8.12 与统一产品接口 2.4 写在一个单独文件里；合同到来时删掉该文件、改为导入（13.5），不在 Web 长期保留第二份格式。

- [ ] **13.2 合成结果夹具**
  - 四份样例，每份给出九个操作的响应（按规格的字段与形状，含 `ResultDescriptor`、`mark`、`next_cursor`）：
    - 完整的概览与脉络；长资料另有 `material-chapters` 的章列表、按章的整份概览，以及带 `chapter_id` 的各章结果；
    - 至少一个问答：一份完整回答，一份进行中（`material-answers` 里有任务、`answer-progress` 有进度）；
    - 按要点的关联：`edge` 依据有已确认与候选两种，`reference` 依据一条；`citations` 的引用数，其中一份来源没有给出总数（`null`）；
    - 所在主题页一页以上。
  - 故意包含：一处与原文不符的数字（带所引片段的原文）、一处“原文未给出”、一份没有关键图表的资料、一份 `freshness` 为 `outdated` 的结果、一份 `on_read_version` 为 `false` 的脉络（对应 `material-marks` 返回 `marks-version-mismatch`）、一处句号算不出的引用（`sentences` 为 `null`）。
  - 另备一份能力报告为“全部可用”，一份为“全部不可用”，一份只有 `reading_layers` 可用。
  - 所有文字是合成的，标明“样例”；可以参考 `sandbox/cases/2026-11-12-reader-mockups/src/argument.js` 的样例文字，但不引用 sandbox 中的文件。
  - `mark` 按[文档与证据 3.5](../../architecture/technical/04-document-evidence.md#35-分句与出处角标目标尚未实现)的分句规则手工算好，作为夹具的期望值。
- [ ] **13.3 让样例库提供合成结果**
  - 在截图与测量的 Playwright 会话里，拦截 `POST /api/v1/query/material-reading` 与 `GET /api/v1/query/status`，按请求里的 `operation` 返回 13.2 的响应，能力报告取三份中的一份；测试用同一份夹具。“不可用”与“只有阅读层可用”各截一组，证明对应的入口不出现。
  - 手动浏览样例库（`serve`）时没有合成结果，服务也不报告能力可用，所以顶栏上没有“概览”“脉络”与提问框；在截图清单里注明这一点。
  - `design-samples-pages.ts` 增加概览、脉络、按问题阅读、库内关联、长资料的页面。
- [ ] **13.4 查询与缓存**：结果按资料与文档版本缓存（规格第 5.1 节）；`material-layers` 的 `pending` 或结果描述变化时按规格第 5.2 节就地更新，并在页眉下方说明；轮询只在有进行中的运行时进行。
- [ ] **13.5 接上计划 16 的合同与服务**（等计划 16 的 14.9）：删除暂存的线上格式文件，改为导入合同；在合成库上用计划 16 的测试帮助函数登记真实结果，用真实的 `material-reading` 与状态读取跑一遍 14–17 的测试，确认视图不改。回答、关联、主题页三类读取在计划 16 的对应块交付之前返回空结果或 `capability-unavailable`，这时 15、16 的真实部分照规格显示“没有”或不出现。

## 集成与影响

- 读取层只读，不发起加工；“发起加工”“提问”走计划 16 的运行流程（`estimate`、`run`，14、15）。
- 合成结果只在测试与截图中出现，不进生产包。

## 验证

- 新增 `apps/web/test/material-reading.test.ts`：
  - 九个操作的请求按规格构造（寻址、`chapter_id`、`cursor`、`limit`）；
  - 每类结果的“没有”“进行中”“过时”“不在正在读的版本上”“完整”五种情形映射正确；
  - `capability-unavailable`、`reading-target-mismatch`、`marks-version-mismatch` 与“没有结果”可区分；
  - 续读把分页拼完整，单页响应不超过 1 MiB 时也能处理截断；
  - 与原文不符、原文未给出、候选关系、`sentences` 为 `null` 在视图模型里可区分；
  - 三份能力报告分别决定两格、提问框与按要点关联是否出现。
- 截图：新增页面能截出（内容由 14–17 渲染，本块只要求页面就绪）。

## 证据

提交号；直接测试结果；九个操作与规格 8.12 的对照表；13.5 完成时的计划 16 版本。

## 退出条件

14–17 可以在合成结果上实现；读取层的类型与规格第 7 节、8.12 逐项对应。13.5 单独退出：计划 16 的 14.9 接上后，14–17 的测试在真实服务上通过。

## 恢复与交接

13.1–13.4 一起退出；13.5 留在本块，等计划 16，不阻塞 14–17。计划 16 的实际响应与规格不一致时，交总设计师判断改哪一边，不在读取层里兼容两种格式。
