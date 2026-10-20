# 10 算子接入文献档案

状态：In progress（第一版 11/11 已实施；新增 10.12 用时核对）。执行者：worker。

**Outcome**：

1. 单篇算子的输入只能是就绪文献的校订稿。算子声明读取哪些部分、哪些章节角色，按元数据和标签选择文献范围。复用键由被读取部分的内容版本、算子版本、规范和模型配置组成。
2. 单篇结果有四种状态：已提取、原文未报告、无该部分、读取不完整。
3. **快照**成为一等对象。它冻结一组文献，以及每篇文献各部分的内容版本和描述版本。可以由筛选条件生成，两个快照之间可以比较差异。
4. 多篇算子的执行分两步：
   - 先在快照上运行声明好的单篇算子，这一步的结果可复用；
   - 再只基于这些单篇结果做汇总。

   输出为带引用的 Markdown 报告或结构化表格。
5. 结果有两种状态：当前、已过时。版本事件（9.7）会让相关结果标记为“已过时”，系统不会自动重算。
6. 总结作为普通的单篇算子，在文献就绪后由用户手动发起，不自动运行。

**进入条件**：09 已完成，包括 9.2 和 9.7。

**责任边界**：
- 本块负责：
  - `analysis/processor*.ts`；
  - `packages/contracts/src/processors.ts`；
  - `application/jobs/processors.ts`；
  - `storage/processor-results.ts` 与处理器 schema 迁移；
  - CLI/MCP 的处理器与快照命令。
- 本块不负责：Web 界面（11）。

## 现状

- `Processor` 有两种 `scope`：`document` 和 `collection`。`accepts` 可以是 `material`、`document`、`result` 或 `knowledge`。
- 结果状态只有 `ok` 和 `empty`。覆盖状态为 `complete`、`partial`、`none`，另外带有 `gaps`。
- `comparison_sha256` 决定是否复用。
- 现有处理器：`labels`（问答标注）、`records`（记录提取）、`knowledge-synthesis`（综合）、`external-extraction`，以及知识分析（`dsh-document-analysis`）。
- 集合运行发布 `ProcessorCollection`，按成员记录结果。
- Owner 已确认，现有结果很少，不需要兼容（README 非目标）。

## Tasks

- [x] **10.1 输入合同调整**

  - 单篇算子的 `accepts` 只能是 `archive-document`（新增的输入种类）。其他输入种类不再对单篇算子开放，因为单篇算子之间不允许互相依赖。
  - `archive-document` 的内容：`{literature_id, parts: [{asset_id, content_version, document_version_id, structure_annotation_id}], description_version}`。
  - `material`、`result`、`knowledge` 三种输入种类：
    - 从单篇算子中移除；
    - 多篇算子只接受快照（10.5）；
    - `external-extraction` 的外部提交协议保持独立，不受影响（ADR 0034 中外部提交的边界不变）。

- [x] **10.2 读取声明**

  `Processor` 新增 `reads` 字段：`{parts: "main" | "supplementary" | "all", roles: Role[] | "all"}`。

  - 可以写在定义中，也可以作为规范的一部分由调用方指定。例如“提取实验条件”声明 `roles: ["methods", "si-methods"]`。
  - `ProcessorContext.readDocument` 和 `searchDocument` 只返回声明范围内的片段，范围由 05.5 的过滤参数实现。
  - 没有声明的部分和角色，在上下文中不可见。
  - 原始解析和区块对照（05.7）在上下文中不可见。

- [x] **10.3 就绪门**

  - 提交单篇或多篇运行时，所有目标文献都必须是 `READY`。`EXCLUDED` 的文献不能被选中。
  - 不满足的文献：
    - 在批量请求中记为成员级缺口 `not-ready`；
    - 不会触发建档；
    - 不会被静默跳过，必须在结果的成员列表中可见。

- [x] **10.4 复用键**

  `comparison_sha256` 的计算输入改为：
  - 处理器 ID 和版本；
  - 规范化后的规范；
  - 方法 hash；
  - 模型配置；
  - 按 `reads` 实际读取的各部分的内容版本。

  描述版本不参与计算。

  验收：
  - 修改标签不影响复用；
  - 修改正文的校订会让读取正文的结果失效；
  - 新增补充材料只影响声明读取补充材料的算子。

- [x] **10.5 快照**

  - **合同**：`Snapshot { snapshot_id, created_at, definition, members[], content_sha256 }`。
    - `definition` 是生成时的筛选条件，或者是显式的文献列表。
    - 每个成员包含：`literature_id`、各部分的内容版本、描述版本。
  - **存储**：新表 `snapshots`、`snapshot_members`。快照不可变。
  - **生成**：
    - 筛选条件可以包含元数据字段、出版形式、文章性质、标签（按主标签或任一标签）、文献状态（只能选 `READY`），以及显式的 ID 列表；
    - 只选取 `READY` 的文献，其余数量在结果中单独报告。
  - **差异**：比较两个快照，列出新增、移除、内容版本变化、描述版本变化的成员。

- [x] **10.6 多篇算子**

  - `scope: collection` 的处理器新增声明 `map: {processor: id@version, spec}`。`map` 指向一个单篇算子，是可选项；如果没有 `map`，汇总直接使用快照成员的描述信息，例如统计计数。
  - **执行**：
    1. 对快照的每个成员运行 `map` 指定的单篇算子，按 10.4 复用已有结果；
    2. 汇总阶段的 `ProcessorContext` 只提供 `map` 结果的记录，以及按引用回读片段的能力（`resolveEvidence`，只读，用于核实）。
  - **输出类型**：
    - `report`：Markdown 正文，每个论断引用来源记录，记录再引用片段；
    - `table`：记录表，沿用现有的 `records` 输出，每个单元格都带证据。
  - 现有的 `knowledge-synthesis` 改造为 `report` 类型的多篇算子，`map` 指向总结算子或记录提取算子。
  - 多个结果不能伪装成多篇独立证据，按实际文献去重。这条规则沿用 ADR 0034。

- [x] **10.7 四种结果状态**

  在 `ProcessorCoverage` 中，按输入部分新增 `outcome` 字段，取值如下：

  | 状态 | 含义 | 与现有字段的关系 |
  | --- | --- | --- |
  | `extracted` | 声明范围内读完，并且有产出 | `status: ok`，`coverage: complete` |
  | `not-reported` | 声明范围内读完，但没有产出 | `status: empty`，`coverage: complete` |
  | `part-absent` | 文献没有声明要读的部分，例如没有补充材料 | 新增 |
  | `incomplete` | 没有读完声明范围，例如超出预算或读取失败 | `coverage: partial` 或 `none` |

  - 补充材料部分存在但“不可用”（未解析或建档失败，见 9.1）时，这部分记为 `incomplete`，原因为 `part-unavailable`。它与 `part-absent`（文献根本没有补充材料）分开记录。
  - `part-absent` 不能被当作 `not-reported`。
  - 汇总时，这四种状态要分别计数并显示。

- [x] **10.8 过时标记**

  - 新增投影表 `processor_result_freshness`，字段为 `result_id` 和 `state`（`current` 或 `stale`），并记录原因（哪个成员、哪个部分、从哪个版本变成了哪个版本）。
  - 由 09.7 的版本事件驱动，处理必须幂等：
    - **单篇结果**：读取的某个部分的内容版本变化，结果标为过时。
    - **多篇结果**：快照中任一成员被 `map` 读取的部分的内容版本变化，结果标为过时。
    - 描述版本变化不会让结果过时。只有当算子在汇总中使用了元数据字段，并且在定义中声明了 `uses_description: true` 时，才会因描述版本变化而过时。
  - 快照本身不可变，不会过时。界面可以提示“按原条件重新筛选会得到不同成员”：按原条件重新生成一次快照并与原快照比较，有差异就提示。
  - 不会自动重算。重算的方式是：基于新的快照，或当前版本，发起一次新的运行。

- [x] **10.9 总结算子**

  这里的“总结”指现有的知识分析，也就是读取全文后生成的总结型 Markdown。它与建档中的元数据步骤无关，元数据始终在建档时完成。

  - 把现有的知识分析（`dsh-document-analysis`，`processor-knowledge.ts`）登记为单篇算子 `summary`，读取声明为 `{parts: "main", roles: "all"}`。
  - **不自动运行**，与其他算子一样手动发起，可以对快照或全库批量运行（Owner，2026-10-20）。
  - 内容版本变化后，旧的总结标为过时。
  - 总结不参与建档和就绪判断，也不能作为其他单篇算子的输入。多篇算子的 `map` 可以引用它，因为那是读取单篇结果。

- [x] **10.10 现有处理器迁移**

  | 处理器 | 改动 |
  | --- | --- |
  | `labels`（问答标注） | 改为 `archive-document` 输入，并加上 `reads` 声明 |
  | `records` | 同上 |
  | `knowledge-synthesis` | 按 10.6 改为多篇算子 |
  | `external-extraction` | 保持外部提交协议不变，只把输入准备换成档案文档 |

  - 处理器版本号全部加 1，旧结果不作为新版本的复用命中。
  - 旧结果在 12 中按 GB 的决定删除。

- [x] **10.11 CLI/MCP**

  | 命令 | 内容 |
  | --- | --- |
  | `snapshot create --filter …` 或 `--ids …` | 输出快照 ID、成员数，以及未就绪而被排除的文献数 |
  | `snapshot show`、`snapshot diff <a> <b>` | 查看快照、比较两个快照 |
  | `processor run <id@version> --snapshot <id>` 或 `--literature <id>` | 发起运行 |
  | `processor results [--stale]` | 列出结果，可以只看过时的 |
  | `processor result <id>` | 显示四种状态的计数与过时原因 |

  MCP 提供对等的工具，在工具说明中写明“只能读取校订稿”和复用规则。

- [x] **10.12 证据的用时核对**（ADR 0037 第二版第 10 节）

  - 由平台统一执行，不由各算子实现。提取出的每个值都引用校订稿片段，平台在结果写入前核对一次，结果记在该值上：
    - 证据片段的 `basis` 为 `text-layer` 或 `manual`，且所引数字能在该页文字层或该片段中找到：`text-layer`；
    - 证据片段为 `image-only` 或 `uncertain`：调用 DSH（视觉）只查看该片段所在页面区域，确认后记为 `image-checked`，否则记为 `uncertain`。
  - `uncertain` 的值照常交付并明确标注；多篇算子的报告与表格保留各值的核对标注。
  - 页面渲染与文字层读取复用 04 的页面工具；核对结果按（片段、值、页面图像 hash、方法版本、模型配置）缓存，不重复调用。
  - 核对模型与预算由 GQ 决定；未配置时，需要视觉核对的值记为 `uncertain`，不伪装成已核对。
  - 处理器合同增加每个值的核对字段；CLI/MCP/HTTP 输出同步增加。

  验收：fake 模型覆盖三种核对结果；文字层能找到与找不到的数字；缓存命中；未配置模型。

## 集成与影响

- 处理器合同发生破坏性变化（输入种类、复用键、状态）。现有结果不兼容（README 非目标）。
- 知识分析从“建档的一部分”变成可选的单篇算子。阅读器的总结展示改为读取 `summary` 的结果（见 11）。
- 新增快照、新鲜度两类存储。

## 验证

- **单篇**：
  - 读取声明的过滤（不可见部分不能读到）；
  - 未就绪文献作为成员级缺口；
  - 复用键的三个验收场景（10.4）；
  - 四种结果状态。
- **快照**：
  - 生成（只选 `READY`）、不可变、差异比较。
- **多篇**：
  - `map` 的复用（新增成员时只运行新成员）；
  - 汇总只能看到 `map` 记录；
  - 报告的引用链和表格的证据可以解析到片段；
  - 去重。
- **过时**：
  - 内容版本事件使相关单篇和多篇结果过时；
  - 描述版本事件不影响结果，`uses_description` 例外；
  - 事件重复处理时幂等。
- **总结**：
  - 就绪后由用户手动发起，建档不自动触发；
  - 内容版本变化后标为过时。
- `pnpm quick` 和相关的 Vitest 测试。

## 退出条件

- 端到端（离线）流程可以跑通：文献就绪 → 单篇算子 → 快照 → 多篇算子 → 修改一篇的校订 → 相关结果标为过时 → 基于新快照重新运行。
- 全部现有处理器已完成迁移。

## 恢复与交接

- 如果 `map` 复用和现有的集合运行（`application/jobs/processors.ts`）冲突，以“不新增第二套调度器”为原则，在现有队列内实现 `map` 和汇总两个阶段。
- 交给 11：快照、运行、结果、新鲜度和四种状态的读取接口。
- 交给 12：旧结果清理的范围，即处理器版本号加 1 之前的全部结果。

[计划入口](README.md)

## 实施与证据（2026-10-20）

- Patch 基线 `2ccf2c2` 上的当前未提交工作区；没有新增 schema 版本，DDL 全在 `storage/sqlite/schema.ts`。
- 10.1–10.4、10.7：合同严格移除旧 document/material/result/knowledge 执行输入与旧 text/knowledge 结果；注册表只接 archive-document 或 snapshot。上下文按部分/角色筛选，单篇复用不含描述版本。外部保留使用独立 external 证据封套，不可执行。四态及不可用补充材料有定向断言。
- 10.5：`analysis/snapshots.ts`、snapshot-engine 与快照合同实现冻结/分页/差异，发布事务核对输入未变化；CLI/MCP 共用应用边界。
- 10.6、10.9：现有任务队列内 map→reduce；summary@2 使用持续 DSH 文档会话；综合只读 map 记录、回查固定证据，失败 map 保留缺口；无新调度器。
- 10.8：版本事件在同一 SQLite 事务中标记过时；结果读取无写入/模型调用；结果成员索引使 absent/incomplete 和无 map 快照均可按文献查询。
- 10.10–10.11：外部准备拒绝未就绪和非校订稿，提交协议不变；CLI 支持 `processor run/submit id@version --literature/--snapshot`、result、results --stale，MCP 对等；详情包含四态计数和过时原因。
- 实际执行：快照 3 项；archive 输入/DSH map/描述声明 5 项；外部准备和 CLI/MCP 2 项；迁移后的数值、related、adapter、恢复用例 7 项；合同/新鲜度/持久结果 10 项。合计 **27 个不同定向用例通过**。名称过滤未选中用例不计入通过；没有运行 200 文献批量压力测试。
- 日志目录 `/tmp/sciretriever-archive-implementation-yzz1ycub/`：snapshot-tests-1、snapshot-interface、processor-strict-contract-tests、processor-external-archive-tests（外部准备通过）、processor-cli-filter-retest（空游标修复后）、processor-migrated-boundaries、processor-completion-checks；source/test strict 编译见 processor-final-source、processor-final-test-types；定向 lint 的 3 项已修复，复验见 processor-lint-retest。
- 当前用户指南同步到 `docs/guides/knowledge-processors.md`。旧知识兼容专用 adapter 测试改为新合同拒绝与失败 map 断言，科学数值、不可变性、证据与恢复测试保留并迁移。
- 残余：Web 生产入口/旧 UI fixture 的迁移归 11；完整历史回归和超大结果传输验收留最终一次。没有运行 Full，也未修改真实库或停止 4174。

### 本轮结束 Full 证据

结束 Full 中快照 3 项、算子档案输入 3 项、新鲜度 1 项及描述声明 1 项通过；map 综合和 200 篇复用出现两项超时，后续定向结果单列于收敛记录，不能改写 Full。10.12 的用时核对仍未实现。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

两项超时的收尾定向结果：快照 map 综合 1 项通过（业务 2,266 ms；真实档案准备有独立 5 秒钩子），200 篇复用 1 项通过（421,643 ms，原 600 秒限制不变）。全部原复用/模型调用/证据/历史集合断言保留，正式生产源码与结束 Full 快照一致；没有再次 Full。

## 第二版实施证据（2026-10-21）

基线 `2ccf2c2` 加未提交工作区；本轮 patch 未提交。证据目录 `/tmp/sciretriever-proofread-v2-zgeot7n6/`。平台发布前生成逐值 value_checks，数字或单位在文字证据中无法找到时照常交付并标为 uncertain；视觉证据通过 DSH 固定区域工具核对并缓存。结果、字段查询、完整导出、map/reduce 与 Web 均携带标注，用量进入 provenance.value_check_usage。未配置不隐式看图或调用模型。value-document-retest.log 的 4 项用时核对通过；value-delivery-regression.log 正向证明未经支持的数值交付为存疑，内部数值/字符串不一致仍拒绝。processor-recovery-retest.log 覆盖持久算子和快照。

所有 Vitest 均使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 与显式 1–3 workers。这里只记录受影响的定向验证；筛选未执行的用例不计为通过。本轮未运行 Full、未新增依赖或数据库版本、未转换本机库。
