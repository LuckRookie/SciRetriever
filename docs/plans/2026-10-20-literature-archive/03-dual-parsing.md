# 03 解析与原始解析

状态：In progress（3.1–3.9 已按第一版实施；按 ADR 0037 第二版需调整 3.5、3.8，新增 3.11；3.10 等待 GS）。执行者：worker。

> 文件名沿用 `03-dual-parsing.md` 以保持链接。ADR 0037 第二版取消了“两种 profile 都必须完成”的要求：建档只需要部署选定的一种 profile。原始解析的合同、存储、两种 profile 的适配和 fake MinerU 都保留。

## Outcome

1. 每个已接纳的 PDF 资产（正文或补充材料）都可以用 `pipeline` 或 `vlm-engine` profile 解析。每种 profile 产出一份不可变的**原始解析**，包括：
   - 中性区块列表 `raw-blocks-v1`；
   - Markdown；
   - 实际引用的图片；
   - MinerU 原始 `content_list_v2.json`，作为追查用的过程证据。
2. **部署 profile**：建档使用哪一种 profile 是部署级设置，初值由 02 的结论确定，不是逐文献的用户选项。默认只解析部署 profile；另一种可以显式请求，结果只供人工查看。
3. 两种 profile 互不影响：一种失败时，另一种的结果保留。
4. 现有文献只有已发布的 VLM Markdown（没有区块）。这种情况登记为“仅 Markdown 的 VLM 原始解析”，可以直接作为初稿（页归属由 04 用文字层确定）。
5. 解析时不发布旧 `ParserResult` 和可读文档（已完成）。

## 进入条件

- GA；
- 3.10 另外需要 GS；
- 3.11 的部署 profile 初值需要 GV（之前用配置默认值，测试不依赖具体取值）。

## 责任边界

本块负责：
- `apps/server/src/parsing/`，包括 `backends/mineru/`；
- 原始解析的 contracts 与存储；
- 解析任务（`application/jobs/processing.ts` 中的 `parse-documents`）；
- 相关 CLI/MCP 命令。

本块不负责：校订（04）和文档表示（05）。

## Tasks

- [x] **3.1 原始解析合同**

  `packages/contracts` 中的 `RawParse` 与 `RawBlocksV1`，字段见第一版记录。区块的页码与坐标只是定位提示（ADR 0037 第 2 节）。

- [x] **3.2 两种 profile**

  `profile.ts` 按名称定义 `pipeline` 与 `vlm-engine` 的请求字段，`model_identity` 按 profile 区分。

- [x] **3.3 归档校验按 profile 区分**

  `convertMinerURawArchive` 显式接收期望的 profile，校验 `middle._backend`，要求 `content_list_v2.json`，只保留实际引用的图片。

- [x] **3.4 存储**

  `raw_parses`、`raw_parse_resources`、`raw_parse_current`；内容寻址发布；被校订版本引用的原始解析不能回收。表结构在单一 `schema.ts` 中。

- [x] **3.5 解析服务与补全目标（第二版调整）**

  已实现的部分保留：`RawParsingService` 是唯一生产入口；逐 profile 记录成功或失败；只重试失败项；相同输入复用。需要调整：
  - `parse-documents` 任务的默认 profile 集合改为**只有部署 profile**；显式传入时可以请求另一种。
  - 数据库补全的 `PARSER_RESULT_READY` 判定改为“正文部分有部署 profile 的当前原始解析”。对于已登记 `vlm-engine-markdown-only` 的旧文献，该登记也满足判定；04 判定需要重新解析时，由 09 报告 `needs-parse`。
  - 删除“两种 profile 都有当前原始解析”的判定代码与对应测试。

- [x] **3.6 移除旧解析生产链**

  已完成：两种 profile 都只发布 RawParse，不发布旧 ParserResult 或 DocumentVersion；旧回执与默认文档 CAS 已移除。

- [x] **3.7 旧库登记**

  `stageLegacyRawParse` 把现有 VLM Markdown 登记为 `vlm-engine-markdown-only`，不调用 MinerU，不改动原数据。

- [x] **3.8 CLI/MCP（第二版调整）**

  - `document parse` 的 `--profiles` 默认值改为部署 profile；说明中写明另一种 profile 的结果只供人工查看，不参与校订。
  - 文档状态显示每种 profile 的原始解析是否存在、是否失败、失败原因，并标出哪一种是部署 profile。
  - MCP 同步调整。

- [x] **3.9 fake MinerU**

  测试 fixture `apps/server/test/raw-parse-server.ts` 按请求 backend 返回合成归档，可注入 backend 不匹配、缺少 v2、未知类型、单 profile 失败、超时。

- [ ] **3.10 真实服务能力检查**（需要 GS）

  - 只读诊断命令，例如 `parser check --profile pipeline`：用仓库内的一页合成 PDF 请求指定 profile，校验返回的归档。
  - 只有在 Owner 授权后，才能对真实服务运行。结果脱敏后记录在本块和 `notes/mineru.md`。

- [x] **3.11 部署 profile 设置**

  - 新增部署级配置项（例如 `parsing.archive_profile`，取值 `pipeline` 或 `vlm-engine`），在 `config status` 中只读显示。
  - 初值在 GV 之前沿用当前行为 `vlm-engine`；GV 之后按 02 的结论更新，并在配置手册中说明。
  - 修改部署 profile 不会改变已有校订版本；新校订使用新 profile 的原始解析，旧版本保留可读。

## 集成与影响

- 解析的 GPU 时间与现状相当（只跑一种 profile）。
- 解析回执与补全目标的语义从“两种都要”改为“部署 profile 一种”，属于已授权的破坏性变更，CLI/MCP/任务/Web 调用方同步修改。

## 验证

- 3.5、3.8、3.11 的定向测试：默认只解析部署 profile；显式请求另一种；补全目标判定；旧库登记满足判定；部署 profile 变更不影响已有版本。
- 只运行相关的定向用例；Full 在最终验收时统一运行一次。
- 不调用真实 MinerU（3.10 除外）。

## 退出条件

- 任一资产都可以得到部署 profile 的原始解析；
- 补全目标与解析默认值按部署 profile 判定；
- 旧库可以登记为仅 Markdown 的原始解析。

## 恢复与交接

- 交给 04：按 (asset, profile) 读取当前原始解析的接口；部署 profile 的读取接口；页面尺寸。

[计划入口](README.md)

## 第一版实施记录（历史）

以下记录描述按第一版（两种 profile 都必需）实施的过程，只作追查参考，不代表当前任务状态。

### 本轮实施记录（2026-10-20）

执行基线：`2ccf2c2` + 开始时已有的 ADR/计划文档改动；本轮代码尚未提交。未启动子代理、未访问真实服务或用户库，依赖与 lockfile 未变。

| Task | 实现证据与实际验证 | 残余边界 |
| --- | --- | --- |
| 3.1 | `packages/contracts/src/raw-parsing.ts`；`raw-parsing-contract.test.ts` 32 项通过，拒绝越界、重复地址、未知类型、越权资源引用及伪造 hash | 仅合成合同验证 |
| 3.2 | `profile.ts`、`protocol.ts`、`configuration/owner.ts`；请求字段对照 MinerU 3.4.4 固定 commit；`raw-parse-protocol.test.ts` 6 项通过 | `config status` 的 `mineru:pipeline`/`mineru:vlm-engine` 表示本地配置具备，未证明远端模型已加载；真实能力待 GS |
| 3.3 | `content-list.ts`、`convertMinerURawArchive`；`raw-parse-archive.test.ts` 25 项通过 | 用独立 raw converter 保留旧 converter，满足 3.6；不将旧 parser 的私有文件要求套到新路径 |
| 3.4 | schema v11、独立迁移、worker、`SqliteRawParseStorage`；已接正式 catalog operator 与 Application；存储 6 项、catalog operator 16 项通过 | 迁移只对系统临时目录合成库执行；真实库未升级；回收不会删除有 pin/current 的版本 |
| 3.5 | `RawParsingService` 及生产组装已实现；默认两种 profile、共享输入校验、重复请求串行复用、逐 profile 失败/取消；服务 7 项通过 | 任务/CLI/MCP 仍使用旧 `ParseDocumentReceipt`，`PARSER_RESULT_READY` 尚未切换，因此此 Task 未完成 |
| 3.6 | raw VLM 成功后发布旧 ParserResult，pipeline 不发布；重开应用复用 raw 后仍可读取固定 Document；服务回归通过 | 旧阅读/分析保留到 GB；最终 Full 已通过；入口切换仍未完成 |
| 3.7 | `stageLegacyRawParse` 验证旧字节并登记 `vlm-engine-markdown-only`；存储测试证明旧关系不变且没有 parser/model 调用 | 旧来源中 model identity 为空时如实保留；不伪造页码区域或区块 |
| 3.9 | `test/raw-parse-server.ts` + 真实生产 loopback/protocol，覆盖 backend 错误、缺 v2、未知类型、单 profile 失败与超时，6 项通过 | 原计划把生产 `loopback.ts` 误称 fake；已依据实际代码责任校正，fake 位于 test，不改变产品合同或生产网络责任 |

实际命令与日志（系统临时测试目录，不随 Git 提交）：

- `pnpm exec tsc -b && pnpm exec tsc -p tsconfig.tests.json`：通过。
- `pnpm exec vitest run packages/contracts/test/raw-parsing-contract.test.ts apps/server/test/raw-parse-archive.test.ts apps/server/test/raw-parsing-storage.test.ts apps/server/test/mineru-http.test.ts apps/server/test/mineru-parser.test.ts`：首次 92 通过 / 1 失败，发现 profile readiness ID 使用斜杠；改为冒号后存储回归通过，不隐去最初失败。
- `pnpm exec vitest run apps/server/test/catalog-schema.test.ts apps/server/test/raw-parsing-service.test.ts apps/server/test/raw-parsing-storage.test.ts apps/server/test/web-default-storage.test.ts apps/server/test/configuration-owner.test.ts`：5 文件 / 41 项通过；日志 `/tmp/sciretriever-archive-implementation-yzz1ycub/raw-integration.log`。
- `pnpm exec vitest run apps/server/test/raw-parse-protocol.test.ts`：1 文件 / 6 项通过。
- `pnpm quick`：通过；日志 `/tmp/sciretriever-archive-implementation-yzz1ycub/quick-03.log`。
- `pnpm full`：已启动，结果待记录；不能用先前 Web 计划的 Full 作为本轮验收。

此前待确认（Owner 已确认并改为完全移除旧 Document）：旧解析回执强制包含非空 Document，不能表达 pipeline 成功而 VLM 失败。已提出逐 profile 成功/失败 + 可选旧 Document 引用的方案；这是已授权破坏性合同清单之外的变化，等待 Owner 答复前不改公开回执。3.10 仍受 GS/GV 约束。

#### 后续回归与复核

- 已补充 MinerU 3.4.4 的空裁图 sentinel：表格/公式的 `images/` 映射为无图片，保留文字/HTML 与原始 v2；不会把目录当作资源。
- 完整 Full 的默认并发在高核数共享服务器上产生大量 5 秒超时，已中断并保留 `full-03.log`。限制为 2 个 worker 的整轮结果为：290 文件（273 通过、1 失败、16 跳过），2057 项（2015 通过、2 失败、40 跳过）；两项失败均是 `next-launch.test.ts` 仍断言 v10。更新为 v11 后，Web 正式启动 3 项回归通过。没有降低断言或提高超时。
- 复用审查发现图片数会放大清单重复读取，已改为 `SqliteRawParseStorage.load` 单次 manifest/closure 加逐字节资源验证；20 张图片的测试验证 catalog 读取固定两次，资源篡改仍被拒绝。解析/存储共 2 文件 / 13 项通过，日志 `raw-bulk-read-final.log`。
- 未知类型的安全标识保留到每个 profile 的 `failure_source_type`，不带任意响应正文；持久状态仍保存稳定失败代码。
- 当前代码快照：`/tmp/sciretriever-archive-implementation-yzz1ycub/current-code-manifest.json`（将于最终 Full 后重新核对）。
- 最终验收使用已有测试 Chromium、已验证的本机 Cloak fixture 与 3 个 worker；外部 parser/model 和页面仍是 fake/loopback。日志 `full-current-final.log`，退出 0：293 文件 / 2,152 项，零跳过；Quick 和生产构建均通过。

#### 3.8 早期回执方案（已被后续确认取代）

旧 `ParseDocumentReceipt.document` 是必填值。新解析可以出现 pipeline 成功、VLM 失败，或者只解析 pipeline，因此不能继续用非空旧 Document 表示全部结果。建议回执显式列出每个 profile 的 `published/reused/failed`、固定 raw ID/hash、稳定失败代码和可选的安全 source_type；旧 Document 引用可为空，且其发布/CAS 失败独立报告，不能撤销已提交 raw 结果。CLI、MCP、durable task 和 Web 调用方同步修改，不保留旧回执适配。

这项公共回执破坏性变更等待 Owner 之前已发出的确认题答复。`mode` 与默认版本 CAS 的语义也须在入口接入时明确记录，不能把“复用当前”悄悄变成真实服务调用，或把“只跑成功 profile”伪装成完整旧文档。

路径说明的处理：之前就 fake 所在位置提出了澄清。核查后确认只是计划对文件职责的笔误；按既有模块责任使用 test fixture，不新增架构决定，也不再将该笔误列为待批准事项。公开解析回执仍需确认。

#### 最终验证快照

当前未提交切片已完成 `pnpm full`：**293 文件 / 2,152 项通过，零跳过，退出 0**，包含 Quick、全部 Vitest 和生产构建。命令使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 及已有测试 Chromium/Cloak bundle；所有业务数据、Provider、MinerU 和模型响应仍为合成或 fake/loopback。

证据位于 `/tmp/sciretriever-archive-implementation-yzz1ycub/`：`full-current-final.log`、`full-current-final.exit`、`verification.json`、`current-code-manifest.json`。最后一轮期间 70 个源码/测试及目录说明文件的 hash 未变化。定稿 Web 原型 hash 未变化，依赖/lockfile 未变，没有 Git commit，没有真实 catalog 迁移。

该结果只证明本块**已实现切片**的离线验收，不将尚未接入的入口、存储或真实质量验证改写为完成。未勾选 Task 仍需继续执行。

#### Owner 追加确认

2026-10-20：Owner 同意公开解析回执修改，并要求清理旧逻辑、不兼容两份逻辑。解析请求采用 profiles 与显式 force（默认复用成功结果，只补缺失/失败 profile）；旧 mode、expected_default_revision 和 Document 回执不再接纳。解析不发布全文。先前 3.6 的共存证据仅为历史过程，不代表最终目标。历史数据删除、真实服务仍遵守各 Gate。

#### 已授权回执接入的实现记录

- `document/service.ts` 已替换旧全文构建实现：固定文献与已接纳 PDF 身份，调用双 profile raw 服务，不发布 Document、ParserResult 或默认阅读关系。
- CLI 的 `--profiles`/`--force`、MCP 加工请求、Web 批量/维护入口同步修改。旧 mode/default CAS 输入明确拒绝；新请求默认复用成功项。
- `document parsing-status` 与 MCP `document_read/parsing-status` 走只读 QueryApplication；Web 任务区分逐 profile 结果和部分结果。部分失败任务可以重试，成功 raw 不回退。
- 原始解析服务 8 项定向回归通过；此前 7 项覆盖单模式失败、取消、重开与复用，新增一项覆盖公共入口和 durable task 的部分失败/恢复。完整 Full 正在收口。
- **3.5 未完成部分**：数据库补全仍有旧 content goal；PARSER_RESULT_READY 需要与后续状态/建档接入一起替换。旧解析生产逻辑的全面退役未完成，不能由本次入口替换宣称全部完成。

#### 数据库补全替换的提交边界准备

- `ParsingSource` 中性读取端口已移入 `parsing/ports.ts`，raw 执行不再从旧 `ParsingService` 模块导入类型。
- RawParsingService 和 DocumentProcessingService 新增内部、非序列化的 publication 回调：只串行提交 raw 事实，网络解析仍由现有调度控制，不能把整个解析过程包在批次 commit 队列内。
- 存储/提交失败使用 `parser-publication`，不误报外部解析服务不可用；已经提交的另一 profile 不回滚。
- 对应直接测试/Quick：`raw-commit-tests.log`、`raw-commit-quick.log`，结果待完成后记录；旧数据库补全目标与旧生产链本身尚未替换，3.5/3.6 保持未完成。

#### 数据库补全与旧解析生产链退役（2026-10-20）

基线仍为 `2ccf2c2` + 未提交工作树。当前代码：

- `BatchGoal` 只含 `ASSET_READY | PARSER_RESULT_READY`；CLI 使用 `complete pdf|parser`，durable Job 使用 `pdf|parser`，旧 content 目标拒绝，不重新解释成新任务。
- `LiteratureCompletionService` 只接纳固定 PDF 并调用两种 raw profile；数据库补全从 current asset/hash 和 raw 事实判定目标。报告移除不再有意义的 `no_usable_content_literature_ids`。
- 网络准备并发，提交进入操作队列；取消不撤销已发布数据，存储失败不会被同时发生的取消掩盖。解析不调用模型、建档或默认文档发布。
- 生产 `parsing/service.ts`、`publication.ts`、旧 `ParserBackend`/输出类型、MinerU `.parse()`、单结果 ZIP 转换与 JSON 回退已移除；Application 只接收 `{ rawParser }`。历史数据 fixture 写入器移至 test 目录，正式包不包含它们。
- 合成 Web 启动先验证临时目录边界，空库初始化当前 schema，再使用正式 runtime。真实配置、服务和文献库均未访问。

验证：`raw-completion-tests-2.log` 的 135 项中 131 项通过，剩余是测试假设/合成 schema 入口问题，随后分别修复；`raw-completion-tests-5.log` 3 文件 / 31 项通过；`retire-parser-tests-3.log` 3 文件 / 61 项通过。退役过程中有两处旧测试问题（fixture 关闭 Promise、schema 缺口断言）及一个真实适配错误（资源路径合同异常未转成 parser-structure），均已修复；后者在 61 项中回归通过。最新 `retire-parser-quick-2.log` 已通过。

Full 正运行 `/tmp/sciretriever-archive-implementation-yzz1ycub/full-raw-retirement.log`；源码快照为 `raw-retirement-source-manifest.json`，结果待完成后记录，不能引用 v14 上一轮 Full 代替。新 profile 的实际科学质量与真实服务能力仍不在本轮授权范围。


Full `full-raw-retirement.log` 已结束（退出 1）：**301 文件中 299 通过、2 失败；2,208 项中 2,206 通过、2 失败，零跳过**，未进入最终 build。741 个代码/配置文件与运行前快照完全一致。两处失败已定位：Browser multipart 测试的默认 5 秒上限短于内部 15 秒等待；取消测试等的是写入开始而非提交完成。现分别修复为明确 30 秒测试预算与实际提交完成信号，事实保留/网络边界断言不变。

语义复核另发现增量 tsc 残留已退役模块的 dist 字节，会被包声明 glob 收进安装包。新增精确清理脚本并接入正式 build，目录/文件必须为实际对象，拒绝符号链接，安装包测试新增退役文件缺席断言；不改依赖和 lockfile。正在进行定向复验，需重新 Full，不能将失败轮称为验收通过。


#### 旧解析退役最终验收（2026-10-20）

`full-raw-retirement-final.log` 退出 0：**302 文件 / 2,211 项通过，零跳过**；Quick、全部 Vitest、最终 build 通过，Vitest 耗时 1,056.92 秒。命令使用已有测试 Chromium/Cloak bundle 与 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1`，仅使用合成或 fake/loopback 服务。

证据目录 `/tmp/sciretriever-archive-implementation-yzz1ycub/`：`raw-retirement-final-source-manifest.json`、`full-raw-retirement-final-snapshot-check.json`、`full-raw-retirement-final.exit`。743 个活动代码/配置文件在运行中 hash 未变；正式构建结束后旧 `parsing/service` 与 `parsing/publication` 的 JS、声明及 map 均不存在。未改锁文件，未访问真实库/服务，未提交 Git。

据此关闭 3.5、3.6、3.8 的离线实施项；3.10 的真实能力验证仍等待 GS/GV。本记录不覆盖随后 07 的元数据代码，也不把旧 Analysis/LiteratureContent 的后续退役写为完成。

### 本轮结束 Full 证据

原始解析服务 12 项、存储 4 项及合同 32 项通过；3.5/3.8/3.11 的第二版改造和 3.10 的真实服务检查仍未完成。 完整命令、失败分类和收尾后定向结果见[测试收敛记录](test-convergence.md)。本块勾选数不因旧流程测试通过而增加。

## 第二版实施证据（2026-10-21）

基线 `2ccf2c2` 加未提交工作区；本轮 patch 未提交。证据目录 `/tmp/sciretriever-proofread-v2-zgeot7n6/`。部署 profile 配置、默认单一解析、补全就绪判断与三端请求已接通。默认 vlm-engine，显式 pipeline 单独完成亦可；旧 Markdown 登记也满足解析补全。定向日志 deployment-profile.log（19 项中 18 通过，剩余因旧双模式隐含默认的用例随后显式指定并通过 profile-completion.log，共 3 项）；真实 13 份样本两种 profile 读取另见 02。无 schema 版本变化。

所有 Vitest 均使用 `VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1` 与显式 1–3 workers。这里只记录受影响的定向验证；筛选未执行的用例不计为通过。本轮未运行 Full、未新增依赖或数据库版本、未转换本机库。

### 第二版高级维护入口复验（2026-10-21）

`maintenance-profile-verified.log`：高级维护的 1 个浏览器用例通过，明确不提交显式 profiles 列表，由服务端采用部署配置，拒绝旧 Document 回执；另一个未选中用例不计通过。夹具只准备原始解析，不再为一个解析入口测试隐式生成校订文档。
