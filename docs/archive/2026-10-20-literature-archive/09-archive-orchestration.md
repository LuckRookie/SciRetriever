# 09 建档编排与就绪状态

状态：In progress（5/10；编排与版本事件已有离线证据；9.2、9.3、9.6、9.8、9.9 尚未达到第二版要求）。执行者：worker。

**Outcome**：

1. **解析与建档是两个独立步骤。** 获取 PDF 后，文献只进入“有 PDF”状态。解析由 03 的解析任务单独发起，建档由本块的建档任务单独发起。两者都不会自动触发：
   - 获取 PDF 不会自动开始解析；
   - 解析完成也不会自动开始建档。
2. 只有正文部分已有部署 profile 的原始解析（或已登记的旧库 VLM Markdown）的文献，才能发起建档。建档依次完成以下步骤：
   1. 校订
   2. 文档表示
   3. 结构
   4. 元数据
   5. 参考文献
   6. 标签

   已经解析的补充材料部分一并建档。各部分之间互不阻塞。

3. **只看正文部分。** 正文部分建档成功、满足就绪条件，文献就是 `READY`。补充材料没有解析或建档失败，都不影响就绪；该部分记为“不可用”，并在问题队列中列出，处理与否由人决定。
4. 文献状态共有六种：

   | 状态             | 含义                                                                         |
   | ---------------- | ---------------------------------------------------------------------------- |
   | `UNREVIEWED`     | 没有主 PDF                                                                   |
   | `ASSET_READY`    | 有主 PDF，还没有就绪。`missing_step` 指出下一步：解析（`raw-parse`）还是建档 |
   | `ARCHIVING`      | 正在建档                                                                     |
   | `ARCHIVE_FAILED` | 正文部分建档失败                                                             |
   | `READY`          | 已就绪                                                                       |
   | `EXCLUDED`       | 文章性质为勘误、社论、观点或评论，不作为文献处理，不进入算子                 |

   就绪判断只使用“满足或不满足”的条件。

5. 版本分两类：
   - 内容版本：每个部分各一个；
   - 描述版本：每篇文献一个。

   版本变化时会产生事件，交给 10 标记相关结果为过时。

6. 建档失败的项目进入问题队列。每个问题都对应一种处理动作，处理后从失败的那一步继续建档。
7. 现有文献可以按旧库模式建档：已登记的 VLM Markdown 直接作为初稿；04 无法确定页归属时报告 `needs-parse`，需要用部署 profile 重新解析。
8. 每批建档结束后，自动执行一次标签整理。

**进入条件**：04–08 的服务入口已完成。

**责任边界**：

- 本块负责：
  - 新目录 `apps/server/src/archive/`（含 README）；
  - `literature/state.ts`；
  - `application/jobs/` 中的新任务类型；
  - 与 `interventions.ts` 的衔接；
  - contracts 中的状态与版本类型；
  - CLI/MCP。
- 本块不负责：
  - 解析本身（03）；
  - 各步骤的内部实现（04–08）。

> ADR 0037 第二版（2026-10-20）：校订改为“部署 profile 初稿 → 文字层找疑点 → DSH 看原图矫正 → 存疑不阻断就绪”。本块受影响的 Task 已取消勾选并写明调整内容；其余已完成项保留。

## Tasks

- [x] **9.1 状态与版本合同**
  - `LiteratureStatus` 改为上述六种状态。
  - `MissingStep` 改为：`primary-pdf`、`raw-parse`、`proofread`、`document`、`structure`、`metadata`、`references`、`tags`。
  - **`ArchiveState`** 包含：
    - 各部分各步骤的状态：`pending`、`running`、`done`、`failed`、`unavailable`。`unavailable` 只用于补充材料，表示未解析或失败；
    - 各步骤的输出引用；
    - 失败项列表：步骤、部分、原因代码、明细引用；
    - 建档模式：`full` 或 `legacy-vlm-markdown`。
  - **内容版本**（每个部分）：`hash(document_version_id, structure_annotation_id)`。
  - **描述版本**（每篇文献）：`hash(metadata_revision, metadata_sha256, tag assignment_sha256)`。
  - 按 Owner 不保留双份逻辑的要求，公开状态和 MissingStep 直接采用新枚举；旧总结不再参与就绪推导。旧产物实际清理留给最后一次副本转换。

- [x] **9.2 就绪推导**（第二版调整：6.9 不再要求参考文献；校订 `complete` 指 04 的处置完整性；存疑不影响就绪；真值表同步更新）

  把 `literature/state.ts` 的 `deriveCurrentState` 改为纯函数，输入为 `ArchiveState` 与当前事实。按以下顺序判断：
  1. 没有主 PDF：`UNREVIEWED`。
  2. 正文部分缺少建档所需的原始解析：`ASSET_READY`，`missing_step = raw-parse`。
  3. 正文已解析，但从未建档：`ASSET_READY`，`missing_step = proofread`。
  4. 有正在运行的建档任务：`ARCHIVING`。
  5. 元数据步骤已确定文章性质为勘误、社论、观点或评论：`EXCLUDED`。人工把文章性质改为其他类别后，重新推导。
  6. 正文部分有未解决的失败项：`ARCHIVE_FAILED`。
  7. 以下条件全部满足：`READY`。
     - 正文部分的校订版本为 `complete`，并已构建为当前默认文档；
     - 正文部分满足 `structureSatisfied`（6.9）；
     - 必填元数据齐全（7.5）；
     - 标签数为 1 到上限（8.3）；
     - 以上结果对应当前的主 PDF。

  补充材料部分的状态不参与判断。主 PDF 变化后，正文部分的各步骤回到 `pending`。新增补充材料不改变文献状态，只新增一个待解析的部分。

  用真值表测试覆盖全部组合。

- [x] **9.3 编排器**（第二版调整前置检查、恢复与校订 `incomplete`）（`archive/orchestrator.ts`）
  - 新增任务类型 `build-archive`，目标为文献选择器或 ID 列表，可选参数 `mode` 与 `from_step`。
  - **前置检查**：
    - `full` 模式：正文部分已有部署 profile 的当前原始解析；
    - `legacy-vlm-markdown` 模式：正文部分已有登记过的 `vlm-engine-markdown-only` 原始解析；04 无法确定页归属时，成员结果记为 `needs-parse`。

    不满足时，该文献的成员结果记为 `needs-parse`，不调用 MinerU，也不自行发起解析。

  - **每篇文献的执行顺序**：
    1. 对每个已解析的部分做校订（04）；
    2. 对每个部分构建文档（05）；
    3. 对每个部分生成结构注释（06）；
    4. 对正文部分执行元数据步骤（07.5）；
    5. 处理参考文献（06.6、06.7）；
    6. 打标签（08.3）。

    补充材料部分的失败不中断正文部分的后续步骤。

  - **幂等**：某一步的输入与方法版本都和已有输出一致时，直接复用，标为 `done`。
  - **恢复**：崩溃或重启后，从第一个未完成的步骤继续。04 的矫正缓存可以避免重复调用模型；`incomplete` 的校订从未检查的页继续。
  - **取消**：正在执行的步骤收到取消信号；已完成的步骤保留。
  - **并发**：
    - 文献之间并行，上限为配置项；
    - 模型调用遵守 DSH 的并发配置。
  - **隔离**：一篇文献失败，不影响同一批次的其他文献。

- [x] **9.4 批次结束钩子**

  `build-archive` 任务结束时（成功、部分失败或取消都算），如果本批有新建的标签，调用一次 08.5 整理。整理失败只记录，不影响建档结果。

- [x] **9.5 触发方式**
  - 解析和建档都只能手动发起，入口为 CLI/MCP/Web。系统中没有任何自动触发。
  - 文献库可以按状态和 `missing_step` 筛选。例如可以筛选“有 PDF、待解析”的文献，批量发起解析；或者筛选“已解析、待建档”的文献，批量发起建档。

- [x] **9.6 问题队列**（第二版调整原因代码）

  每类失败对应的处理动作：

  | 原因代码                                                                         | 处理动作                      | 之后           |
  | -------------------------------------------------------------------------------- | ----------------------------- | -------------- |
  | `proofread-incomplete`（未处置的疑点或未检查的页，例如预算用尽、矫正模型未配置） | 继续校订，或 4.10 的人工处置  | 从校订继续     |
  | `proofread-failed`（页面在校订稿中没有对应内容、矫正异常中止）                   | 重试，或 4.10 的人工决定      | 从校订继续     |
  | `needs-parse`（旧库 Markdown 无法确定页归属）                                    | 用部署 profile 重新解析（03） | 解析后重新建档 |
  | `references-missing`（标注“不影响就绪”）                                         | 可忽略，或 06 的修正          | 从参考文献继续 |
  | `metadata-missing:<field>`                                                       | 7.6 的人工编辑                | 从元数据继续   |
  | `structure-unsatisfied`                                                          | 06 的角色修正                 | 从结构继续     |
  | `tags-empty` / `tags-invalid`                                                    | 8.9 的人工设置                | 从标签继续     |
  - 补充材料部分的失败也会列入队列，但标注“不影响就绪”，可以忽略。
  - 解析失败不进入本队列，由 03 的解析任务记录和重试。
  - 衔接现有的 `InterventionService`：
    - `continue`、`skip`、`cancel` 三种结果可以对应到队列条目；
    - 对正文部分的问题使用 `skip`，不会使文献变为 `READY`。
  - 支持批量处理。

- [x] **9.7 版本事件**
  - 某个部分的内容版本变化时，产生 `content-version-changed(literature, part, old, new)`。
  - 描述版本变化时，产生 `description-version-changed(literature, old, new)`。
  - 补充材料部分从“不可用”变为建档成功，也算该部分的内容版本变化。
  - 事件持久化，由 10 消费，消费过程要求幂等。

- [x] **9.8 旧库模式**（第二版调整）
  - 前置条件：
    - 已用 3.7 登记现有的 VLM Markdown。不再需要补跑 `pipeline`。
  - `mode = legacy-vlm-markdown` 时，04 用文字层确定 Markdown 段落的页归属（4.3），后续步骤与 `full` 模式相同。
  - 无法确定页归属的部分（例如含 `image-only` 页）报告 `needs-parse`；用户显式发起部署 profile 的解析后，再以 `full` 模式建档。

- [x] **9.9 统计**

  每次建档记录以下数据，只用于观察，供 12 的重建报告和成本估算使用：
  - 每一步的耗时；
  - 按步骤统计的模型调用次数和 token 数；
  - 校订分类统计（4.10）。

  解析的页数和耗时由 03 的解析任务记录，`archive stats` 汇总展示两部分数据。

- [x] **9.10 CLI/MCP**

  | 命令                                                     | 用途                           |
  | -------------------------------------------------------- | ------------------------------ |
  | `archive build <selector> [--mode] [--from-step]`        | 发起建档                       |
  | `archive status <id>`                                    | 查看各部分、各步骤的状态与版本 |
  | `archive issues [--reason] [--part main\|supplementary]` | 查看问题队列                   |
  | `archive resolve …`                                      | 按问题类型处理                 |
  | `archive resume <id>`                                    | 从失败处继续                   |
  | `archive stats`                                          | 汇总统计                       |

  文献库查询的状态筛选改为新的状态枚举，并支持按 `missing_step` 筛选。

## 集成与影响

- 文献状态的含义发生变化：`READY` 取代 `CONTENT_READY`，成为“可用”的标准。Web 和机器接口的状态展示都要更新（11）。
- 新增任务类型。
- 获取、解析、建档三个阶段彼此独立，各自手动发起。

## 验证

- **端到端（离线）**：
  1. 使用 fake MinerU（部署 profile）和 fake 模型；
  2. 从入库 PDF 开始，先手动发起解析，再手动发起建档，直到 `READY`；
  3. 带补充材料和不带补充材料的情况都要覆盖。
- **前置检查**：对未解析的文献发起建档，结果为 `needs-parse`，并且没有任何 MinerU 调用。
- **补充材料**：补充材料校订失败时，文献仍为 `READY`，问题队列中有一条标注“不影响就绪”的条目；处理之后会产生补充材料的内容版本事件。
- **EXCLUDED**：文章性质为勘误时，文献状态为 `EXCLUDED`；人工把文章性质改为研究论文后，重新推导为 `READY`。
- **失败注入**：对正文部分的每一步分别注入失败，检查三点：状态变为 `ARCHIVE_FAILED`、队列中出现条目、处理后可以继续。
- **幂等与恢复**：同一篇文献重复建档，不会重复调用模型；进程中断后可以继续。
- **取消**：取消后已完成的步骤保留；再次发起时从断点继续。
- **版本事件**：人工修改校订会产生内容版本事件；修改标签会产生描述版本事件。
- **就绪真值表**：覆盖 9.2 的全部条件组合。
- `pnpm quick` 以及相关的 Vitest 测试。

## 退出条件

- 合成文献按“解析 → 建档”两个手动步骤可以达到 `READY`；
- 补充材料失败不影响就绪；
- `EXCLUDED` 推导正确；
- 失败可以处理和恢复；
- 版本事件可用；
- 旧库模式可以运行。

## 恢复与交接

- 状态读取、SQL 筛选和生产调用方统一使用新枚举；不恢复旧状态兼容分支。Web 完整交互与旧业务链退役分别在 11、12 收口。
- 交给 10：
  - `READY` 判断；
  - 部分、内容版本和部分可用性；
  - 描述版本；
  - 版本事件流。
- 交给 11：状态、`missing_step`、问题队列和统计接口。
- 交给 12：旧库模式与统计，用于真实库重建。

[计划入口](README.md)

## 实施证据（2026-10-20）

基线 `2ccf2c2` 加当前未提交 patch；未提交 Git，未改变依赖。所有表、视图和版本事件触发器直接写入当前 `schema.ts`，数据库版本仍为 11。真实 catalog 和 4174 服务未操作。

- 9.1–9.2：`packages/contracts/src/archive.ts`、`literature/state.ts`；worker 与库筛选调用同一纯函数，128 个就绪条件组合在一个真值表用例中核对。旧总结存在也不能使文献就绪。
- 9.3–9.5：`archive/orchestrator.ts` 与现有 `ProcessingTaskService/ExecutionQueue`；共用一个批次租约并限流并发，不引入第二个调度器。步骤持久化、取消、重启恢复和复用均有直接用例。raw 前置失败零解析调用，整理失败只记账。
- 9.6：`archive/service.ts`、`archive-engine.ts`；六个步骤逐一故障注入、跳过不变就绪、补充材料失败后恢复。处理决定复用 `InterventionResolution`，写事实仍经各自 owner，问题确认不代替事实修改。
- 9.7–9.8：内容/描述投影和事务内 outbox；角色、元数据、人工校订变化均产生事件，旧库模式明确选择 Markdown-only VLM 输入。CLI/MCP/只读 QueryApplication 已验证。
- 9.9：`raw_parse_attempts` 与 `archive_attempts` 保存解析页数/耗时、步骤耗时与报告用量，结构分类返回本次用量。`archive stats` 直接用例核对 metadata 1 次/100 输入 token、tags 2 次/200 输入 token（均为 fake 回执）。
- 9.10：`archive build/status/issues/resolve/resume/stats/events` 与 `archive_query/archive_manage` 共享入口；指南见 `docs/guides/literature-archive.md`。目录忽略规则对活动 `src/archive/` 作精确例外，历史 archive 仍被忽略。

定向结果：20 个不同用例通过，范围为 archive-state（1）、archive-orchestration（3）、archive-recovery（3）、archive-mode-and-interfaces（2）、literature-state（1）、execution-queue（9）、structure-annotation 的发布/复用/锁定用例（1）。名称过滤造成的 skipped 不是新增源码跳过。

证据目录：`/tmp/sciretriever-archive-implementation-yzz1ycub/`。主要日志：`archive-flow-6.log`、`archive-recovery-1.log`（12 过/1 个测试输入错误，后续已修）、`archive-edits-retest.log`、`archive-boundaries.log`、`archive-mode-interfaces.log`（2 过/1 个 CLI 返回形状断言错误，后续已修）、`archive-last-targets.log`、`archive-cancel-published-retest.log`。源码与测试类型检查、定向 ESLint、diff 空白检查均通过；没有运行 Full。

残余边界：未调用真实 MinerU 或 Provider，仲裁仍是 `arbitration-unavailable`；最终 Full 和真实材料质量验收不在本块冒充完成。模型没有返回用量的失败只保留失败事实，不估算 token。10 尚未实施事件消费与过时投影，11 尚未接入页面。

下一安全动作：10 算子接入；真实库继续不转换，待 08–10 表结构定稿后再按备份、副本核对、Owner 确认、停 4174 服务、切换的顺序只转换一次。

## 本轮测试收敛台账核对（2026-10-20）

依据 Owner 本轮仅修 A/B、保留 C 的授权核对；不把第一版实现或历史 Full 当成第二版验收。本轮证据目录：`/tmp/sciretriever-test-convergence-ndZSeC`。

- 9.9：取消勾选。页数、耗时和调用计量已有实现；但本 Task 依赖的校订统计仍是第一版 agreed/substantive/one_sided/hard_check_failures，第二版疑点/处置/存疑统计尚未实现。

### 本轮结束 Full 证据

结束 Full 中建档编排 3 项、恢复 3 项与状态 1 项通过；旧就绪规则与旧库模式的 C 类阻断仍保留。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

## 第二版实施证据（2026-10-21）

基线 `2ccf2c2` 加未提交工作区；本轮 patch 未提交。证据目录 `/tmp/sciretriever-proofread-v2-zgeot7n6/`。建档前置改为部署 profile 或旧 Markdown，incomplete 明确进入问题队列；旧 Markdown 定位失败映射 needs-parse；参考文献失败/缺失仍记录问题但继续标签且不影响就绪。统计改为页面、疑点、处置、存疑与实际用量，不再读取旧仲裁分类。archive-v2-readiness.log 的状态/编排 6 项通过；archive-document-retest.log 的旧模式与结构复验通过；processor-recovery-retest.log 7 项覆盖故障恢复、取消/重开、人工版本、算子复用与快照综合。

所有 Vitest 均使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 与显式 1–3 workers。这里只记录受影响的定向验证；筛选未执行的用例不计为通过。本轮未运行 Full、未新增依赖或数据库版本、未转换本机库。

### 内容相同的校订版本复用（2026-10-21）

最终调用方审查发现：Document 按内容复用、保留最初来源绑定，但就绪投影视图还要求当前 proofread_id 与 Document 绑定 ID 相同；仅方法版本改变便会错误丢失当前文档。视图现在以固定输入资产加校订内容 hash 对应：方法变化而正文/依据/结构字节不变时保留文档，有真实内容变化仍失效。只修改当前 `schema.ts` 的视图，没有新增版本或迁移真实库。直接回归见 `archive-content-identity.log`。
