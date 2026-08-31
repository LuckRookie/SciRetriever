# LLM 配置 UX 收敛计划

> 历史实施记录，非当前产品或架构真相源。当前行为以 requirements、Accepted ADR、current
> docs、源码与测试为准。

## 身份与状态

- Run ID：`2026-08-26-llm-configuration-ux`
- 创建日期：2026-08-26
- Primary owner：当前主会话
- Baseline revision：`b1322d32d9689ebf65b27e65eae13f3c6a855007`
- 执行模式：single-session、串行；并行 Human Gate 未批准
- 当前状态：Completed and archived — 2026-08-26
- 最近恢复点：Blocks 01–05、Full、fresh-wheel 与 R5 已全部闭环

## 目标观察

用户第一次进入 `sciretriever config` 的 LLM 设置时，只需理解服务、Base URL、协议、
模型、上下文、视觉能力和默认思考程度；官方服务的固定值不重复询问，模型可以通过一次
显式只读请求获取，失败后仍能手工配置。保存前展示不含 secret 的清晰摘要。Analysis 内部
预算和 Browser 图像/工具上限不再阻塞基础配置，但仍可在 Advanced 中维护。

## 授权与真相源

- 用户已明确要求打磨 LLM 配置 UX，并给出基础字段范围。
- 产品边界：[requirements](../../architecture/requirements.md)。
- 无状态 Agents 与双角色合同：[ADR 0017](../../architecture/decisions/0017-shared-agents-and-controlled-browser-agent.md)。
- 固定用户配置与 secret 分离：[ADR 0018](../../architecture/decisions/0018-fixed-user-configuration-home.md)。
- 后续外部 Agent/SDK 迁移边界：[ADR 0019](../../architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md)；
  本计划只收敛当前配置 UX，不提前实施 PydanticAI、MCP、Skill 或 LangGraph。
- 模块责任：[design](../../architecture/design.md)、[Agents 技术文档](../../architecture/technical/agents.md)、[Configuration 技术文档](../../architecture/technical/configuration.md)。
- 本计划不能改变 `~/.sciretriever/config.toml` / `credentials.toml` 固定身份、origin-bound
  secret、无状态 Agent、Browser controller 互斥选择或离线 Harness 边界。

## 事实、假设与开放问题

### 已核实事实

- 旧基础向导要求用户选择八项 Analysis 预算，并另行填写 Browser 的模型、输出、图片和工具上限。
- 当前三个协议均没有请求侧 reasoning/thinking 配置；当前也没有模型列表实现。
- OpenAI 官方 `GET /models` 只承诺模型基本身份；不能据此猜测 context 或视觉能力。
- Anthropic 当前 `GET /v1/models` 可返回模型身份以及可选 context、输出、图像与 effort capability。
- 当前角色配置已经有结构化文本、图片与工具能力字段，可承载简化向导的结果。

### 执行假设

- “模型自动获取”表示用户在向导中明确选择后执行一次有界只读请求，不表示 `config status`
  自动联网，也不持久化远端 catalog。
- “默认思考程度”采用 provider-neutral 的 `provider-default / low / medium / high`；
  `provider-default` 不发送协议参数，另外三项由 adapter 显式映射。
- 视觉为 `true` 时，基础向导为 Analysis 声明图片能力，并为同一模型建立 Browser role；
  视觉为 `false` 时只清除同模型的 Browser 自动绑定，不删除一个不同模型的既有 Browser role。

### 开放问题

无阻断问题。不同模型是否实际支持严格结构化输出、工具或所选 effort 仍须由用户显式
`config test` 验证；模型目录不提供的事实必须由用户确认。

## 范围与非目标

### 范围

- 简化 LLM 基础向导和 Advanced 入口；
- 增加有界、origin-bound、只读模型发现；
- 增加角色级默认思考程度并由三种 adapter 消费；
- 根据 context 生成基础 Analysis 安全预算并保护兼容的已有高级值；
- 同步 status、示例、用户指南、技术文档、直接测试与安装包行为。

### 非目标

- 不建立持久模型 catalog、自动模型评分或自动选择“最佳模型”；
- 不猜测 OpenAI 模型 context、视觉、结构化输出或 effort 支持；
- 不读取或探测当前操作者的真实配置、secret 或 LLM 服务；
- 不改变 Agent workflow、Browser 动作集合、数据库 schema、文献事实或 PDF 获取顺序；
- 不 commit、push、发布，也不启用并行执行。

## 全局验收条件

- [x] 新用户通过基础向导只回答用户可理解的基础问题即可形成 Analysis-ready 配置。
- [x] 官方服务不询问固定 Base URL/协议，自定义服务不要求理解内部 `service_name`。
- [x] 模型发现只有显式选择才联网，使用共享 Network、origin-bound credential 和有界解析；
  任一失败均脱敏并回退手工输入。
- [x] 视觉与 reasoning 配置进入生产 role binding 和 adapter 请求，不是展示占位符。
- [x] 旧配置缺少新增字段仍可读取；兼容高级预算和不同 Browser 模型不会被无意删除。
- [x] `config status` 仍纯本地并清楚展示模型、context、vision、reasoning 和 Browser 绑定。
- [x] 相关测试、Quick、Full、fresh-wheel installed acceptance 和 R5 审查闭环。

## 分块地图与依赖

| Block | 结果 | 主要改动面 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [01](01-contract-and-ux-baseline.md) | 产品/架构/UX 与兼容合同闭合 | requirement、ADR、计划、回归基线 | 无 | Completed |
| [02](02-model-discovery-and-reasoning-contract.md) | 模型发现与 reasoning 成为真实底层能力 | Model、Agents、Network、Bootstrap、adapter | 01 | Completed |
| [03](03-guided-configuration-flow.md) | 基础向导与 Advanced 渐进披露可用 | CLI、Config UI、Configuration editing | 02 | Completed |
| [04](04-status-docs-and-installed-behavior.md) | 状态、示例、指南与安装后行为一致 | status、README、docs、example、acceptance | 03 | Completed |
| [05](05-verification-review-and-handoff.md) | 全量证据、R5 与交接闭环 | tests、Harness、wheel、diff review | 04 | Completed |

## 跨块合同

- `config status`、home rendering 和普通业务命令不得因模型发现隐式联网。
- secret 只在短生命周期内传给 origin-bound Network 请求，不进入 model、日志、diff、状态、
  exception、计划或测试 fixture；现有 secret 可按相同 origin 复用但不回显。
- Provider 模型目录是易变 observation，不进入用户配置；只有用户最终确认的字段被保存。
- 基础向导的自动默认必须满足当前 Configuration validators，不以放宽校验换取“可保存”。
- 旧配置与独立 Browser role 采用增量兼容；不存在旧向导兼容层或第二套运行路径。
- 外部协议解析严格有界，未知形状失败关闭并允许 UX 回退手工输入。

## 影响矩阵

| 面 | 变化 |
| --- | --- |
| CLI | LLM 菜单、基础向导、Advanced、确认摘要变化 |
| 配置 schema | `AgentRoleConfig` 增加向后兼容的 reasoning 默认字段 |
| 数据/数据库 | 无变化 |
| Agents/Bootstrap | role binding 传播 reasoning；增加非持久模型发现装配 |
| Network | 复用现有 HTTP 与 destination/origin policy；不新增 transport |
| 凭据 | 文件格式不变；向导可在同 origin 短期复用已有 API key |
| 依赖 | 预计无新增依赖、无 lockfile 变化 |
| 文档/打包 | requirements、ADR、技术文档、指南、示例和 wheel 验收更新 |

## 风险与转化信号

| 风险 | 控制 | 转化信号 |
| --- | --- | --- |
| 模型目录被当成能力真相 | 可选字段只作建议，未知继续询问，保存后建议 probe | Provider 形状不能稳定映射时退回只取 ID |
| reasoning 参数不被模型支持 | `provider-default` 省略参数，显式级别由 probe 验证 | 某协议没有稳定映射时该协议只允许 default |
| 新 context 与旧预算冲突 | 先保留可验证的旧值，否则生成 context-aware 安全值并明确摘要 | 无法形成有效默认时返回设计而非放宽校验 |
| 向导意外覆盖 Browser 独立模型 | 只自动维护同模型绑定；不同模型原样保留 | 需要强制单模型时先取得新产品决定 |
| 工作树已有大量受保护改动 | 逐文件最小 patch、任务相关 diff 审查 | 发现重叠语义冲突时停止并路由 |

## 验证与证据策略

1. Model/adapter/model-catalog 直接单测；
2. Configuration parsing/editing/status 直接单测；
3. CLI plain 与 Rich seam 测试，全部外部请求使用 fake；
4. `scripts/harness.py quick`；
5. `scripts/harness.py full`；
6. fresh-wheel installed acceptance；
7. R5 对目标、UX、架构、secret、兼容、文档、wheel 和最终 diff 做语义审查。

证据写入各 Block 的“完成证据”；不提交原始终端日志、真实响应或 secret。

## 授权门

- 真实 LLM/模型目录探测：未授权，本计划只运行 fake/fixture。
- 并行实现或子 Agents：未授权，保持串行。
- Git commit/push/PR/发布：未授权。
- 破坏性 Git、真实配置/凭据读取、用户数据迁移：禁止。

## 执行方式

Primary owner 按 Block 01→05 串行执行。每个 Task 先预检调用方与受保护改动，再完成最小
实现、直接测试、slice review 和复选框证据；共享配置合同只在 Block 02 稳定后交给 CLI。
只读文件调查可以批量执行，但不形成多个实现 owner。

## 执行审查

- R0：本 README 的事实、范围、合同、风险、验证和授权完整后才能实施。
- R1：每块核对前置证据、owner、重叠工作、测试入口和外部授权。
- R2：每个切片审查错误路径、secret、兼容、UX、测试与范围。
- R3：块内 Task 与直接证据齐全后才 Completed。
- R4：Model/Agents/Bootstrap/CLI 汇合后检查生产对象图和序列化一致性。
- R5：Full 与安装包后对用户结果和集成 diff 做最终审查。

Blocking finding 停止执行；material finding 路由回产生合同的 Block；ordinary finding 在当前
Block 修复并重新验证；未授权真实探测只能记录为 residual risk。

## 进度规则

Task 只有实现、直接测试和审查同时成立才勾选。Block 只有全部 Task、退出条件和完成证据
闭环后改为 Completed。本计划只有全局验收全部满足、R5 通过和交接完整后才 Completed。

## 恢复与续作协议

失败时停止在最近一个通过直接测试的 Task，不回滚工作树。续作首先读取本 README、当前
Block、`git status --short` 和相关 diff；确认 baseline 与受保护用户改动后，从第一个未勾选
Task 恢复。若事实改变接口、owner、风险或授权，先更新计划与真相源，不在下游堆补丁。

## 变更记录与最终交接

| 日期 | 变化 | 原因 |
| --- | --- | --- |
| 2026-08-26 | 建立五块串行计划 | LLM UX 涉及配置、Agents 协议、Bootstrap、CLI、文档与安装包闭环 |
| 2026-08-26 | 完成五块并归档 | 直接测试、Quick、Full、fresh-wheel 和 R5 全部闭环；长期事实已同步到权威文档 |

## 最终交接

- 实际范围：基础向导收敛为 Service → Credential → Model → Capabilities → secret-free Review；
  官方服务隐藏固定 endpoint/protocol，自定义服务安全推导内部身份；八项 Analysis 预算和独立
  Browser 模型进入 Advanced。
- 三项能力：Analysis 通过同一共享 Agent service 配置；vision 可建立同模型 Browser role，
  Browser 下载还必须另行具备 Agent controller、Profile/fixed identity 与 CloakBrowser runtime；
  MinerU 保持 operator-managed 3.4.4/protocol 2，并提供不上传 PDF 的 health test。
- 合同变化：`AgentRoleConfig.reasoning_effort` 是向后兼容的新增普通字段，缺失时为
  `provider-default`；显式级别进入三种 Provider wire request。status JSON 增加相应 role 字段，
  数据库、资产、credential schema 与持久化事实不变。
- 模型发现：只在向导中明确选择后通过共享 Network 执行一次有界 `GET /models`；不跟随
  redirect、不 retry、响应上限 1 MiB、最多展示 100 项、不持久化。服务切换时不会复用同名模型
  在旧 endpoint 上的 context/vision/reasoning 默认。
- 验证：253 项聚焦回归通过；最终 Quick 通过；最终 Full 为 2,156 tests、4 skipped、Pyright
  0 errors/0 warnings，wheel build/content 通过；两条定向 fresh-wheel 核心旅程通过。详细证据见
  Block 05。
- 安全与范围：未读取真实 HOME 配置、secret、Cookie、Profile 或用户语料，未连接真实 LLM、
  MinerU 或 Publisher；无依赖/lockfile、数据库/schema 或资产变化。Full 生成的 `build/`、
  `dist/` 保持 ignored，未进入交付 diff。
- 残余风险：真实模型 capability、credential、MinerU health、CloakBrowser/Profile 和文章授权
  仍须操作者显式 probe；模型目录只是当次服务声明。4 个 Full skip 均是未 opt-in 的真实
  CloakBrowser runtime 边界，符合本计划的离线授权。
- 后续边界：PydanticAI/SDK transport gate、MCP、Skill 和外部 Codex/DeepSeek Harness 入口由
  ADR 0019 约束，本计划没有提前建立迁移双路径。
- Git/发布：未 commit、push、创建 PR 或发布；工作树中其它已存在的 Agents/Browser/配置迁移
  改动保持受保护。归档位置为 `docs/archive/2026-08-26-llm-configuration-ux/`。
