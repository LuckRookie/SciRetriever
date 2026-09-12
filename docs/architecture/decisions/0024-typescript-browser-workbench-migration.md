# ADR 0024：TypeScript 与 Browser 工作台迁移边界

- Status: Accepted
- Date: 2026-09-09
- Supersedes: none
- Amends: [ADR 0011](0011-literature-database-centered-incremental-maintenance.md)、[ADR 0012](0012-process-local-provider-access-scheduling.md)、[ADR 0013](0013-decoupled-discovery-and-database-maintenance.md)、[ADR 0016](0016-cloakbrowser-fixed-identity-runtime.md)、[ADR 0017](0017-shared-agents-and-controlled-browser-agent.md)、[ADR 0019](0019-agent-operable-application-and-sdk-model-runtime.md)、[ADR 0021](0021-provider-model-registry-and-direct-task-selection.md)、[ADR 0023](0023-generic-browser-agent-executor.md)
- Related: [产品需求](../requirements.md)、[设计文档](../design.md)、[TypeScript 工作台技术文档](../technical/typescript-workbench.md)、[活动迁移计划](../../plans/2026-09-07-typescript-browser-workbench/README.md)

## 背景

SciRetriever 的历史生产实现是 Python 模块化单体。TypeScript 与 Browser 工作台迁移需要一套可安装、可
测试和可恢复的实现边界，但不能通过计划文件自行创建第二个文献数据库、第二个 Browser owner 或一套
与 Accepted ADR 冲突的配置语义。迁移完成后还必须区分“新的实现已经通过离线验收”和“真实数据切换已经获得授权”。

## 决策

### 1. 迁移是实现替换路线，不是双写路线

TypeScript workspace、Application、CLI 和 portable package 是当前生产运行路径。Python 源码、历史测试和
Harness 仅作为离线 oracle 与维护材料保留，不由 TypeScript 通过 RPC 或子进程调用。两套实现不同时写同一个
生产 Catalog、ArtifactStore、用户配置或用户 Profile；历史 Python 入口已经按 T061 退役。真实用户数据切换、
发布和删除历史材料仍需要独立的 release 授权，本 ADR 不替代该授权。

v1 的 Model、canonical bytes、hash、SQLite schema、FTS、查询分页、关系和资产引用先作为兼容输入冻结。
TypeScript 先比较原始 bytes，再比较 hash；不能通过修改既有 golden、宽松解析或隐式迁移消除差异。

### 2. 运行时 owner 保持单一

TypeScript 的目标对象图按以下边界组装，消费者只依赖中性合同：

| Owner             | 持有和决定                                                                                | 明确不拥有                                               |
| ----------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Configuration     | 普通配置、Provider/Model 注册、任务选择、凭据 grant 和固定 home 文件边界                  | 文献事实、动态限速、Provider 业务响应                    |
| Network           | HTTP、DNS/IP、SSRF、逐跳 redirect、credential origin、scope/host budget 和安全 transport  | Provider 字段语义、文章身份、PDF 归属、Literature 状态   |
| Browser Host      | 唯一 CloakBrowser process/context、Profile lease、page、Observation、封闭动作和确定性清理 | API 请求、任意 URL/selector、Cookie/secret、PDF 成功结论 |
| Agents            | provider-neutral 单次调用、协议转换、capability、bounded stream、usage、cancel 和稳定失败 | Browser/Page/CDP、长期 memory、文献事实写入              |
| Acquisition       | 来源路由、Candidate 生命周期、PDF 字节门、文章/版本归属门和 primary-pdf 发布决定          | Browser vendor 对象、数据库连接、模型自然语言成功结论    |
| FileStore         | 文件字节、相对引用、hash、不可变发布和冲突证据                                            | 文献身份、current metadata、候选接纳业务决定             |
| DB Worker/Storage | SQLite 连接、typed command、事务和已确认事实的读写                                        | 身份合并、主资产选择、报告状态和网络策略                 |
| Literature        | MetaLiterature/Literature identity、current facts、版本、provenance 和关系含义            | HTTP、文件原语、vendor response 和运行时事件             |
| Application/Entry | 唯一资源组装、生命周期、用户命令、报告和认证控制面                                        | 第二套 owner、原始 vendor 对象、隐式外部 I/O             |

Application 只负责组装一份共享资源图。Network、FileStore、DB Worker 和 Browser Host 各自在进程内只有
一个相应 owner；adapter 不创建旁路连接、limiter、数据库或 Browser。

### 3. Browser 和 Agent 继续遵守既有安全合同

Browser 生产 runtime 只采用 ADR 0016 的 operator-managed CloakBrowser 固定身份 Profile、共享
persistent context 和原始网络出口；ADR 0023 的唯一 `browser:generic` controller 负责页面策略。Agent
每次只消费绑定当前 article/page/revision 的稳定 Observation，并提交一个六选一的封闭动作。Network
在每次 navigation、popup、response 和 download 前重新执行 admission；Acquisition 独立执行 PDF 字节门
和目标文章归属门。Challenge、登录、MFA、拒绝、未找到和资源阻断保持不同的稳定结果，不是自动成功。

Browser Candidate 在 `durable-ready` 后由 FileStore/Acquisition 独立持有，不依赖页面、截图、Agent、
工作台或 websocket 存活。Candidate 不是 Literature，也不能直接写 current facts；候选发布必须留下
可恢复的文件与数据库对账证据。

### 4. v2 运行事实与 v1 文献事实隔离

job、attempt、event、candidate、receipt 等运行事实只有在后续 execution schema 任务中，于合成副本
显式升级和回滚验证。它们不能改变 v1 Literature current facts，不能成为第二个文献数据库，不能把
非持久化报告或动态 Network 状态写入 Catalog。生产库的 schema、数据迁移和双写不在本 ADR 授权范围内。

### 5. 合同与验证归属

共享 Model 只承载领域中立、可序列化和可审计的稳定值；vendor request/response、secret、Page/Context、
绝对路径、binary stream、动态 queue/circuit 和临时报告细节留在所属边界。每个能力切片必须有行为命名
的直接测试、失败路径、必要文档和脱敏证据；按项目 owner 于 2026-09-10 的明确决定，后续质量门改为 TS Quick/Test/Full，
不再默认执行 Python Full；历史 Python 验证工具保留但不作为 TS 交付前置。该修订只改变验证路线，绿色
结果不能替代 R4/R5 语义审查或切换授权。

具体 SQLite binding、CloakBrowser binary 版本、Provider endpoint 和真实站点效果仍由对应 spike、
Provider Notes 或现场授权决定，本 ADR 不凭空固定这些易变事实。

## 后果

- 迁移可以逐块替换实现，并且每个 owner 都有明确的生产者、消费者和恢复入口。
- Python 历史事实通过冻结 golden 和合成副本保持可追溯，TypeScript 负责当前生产运行时和新运行时行为。
- Browser、Network、Acquisition 和 Agents 的边界可以分别测试，模型或页面状态不能越权形成业务成功。
- 后续开发与验收采用 TS 入口，Python 工具保留为历史维护；最终阶段仍承担安装、回滚、兼容性证据和授权审查成本。

## 不采用的方案

- 让 TS 和保留的 Python 历史工具同时写生产数据库：会产生双写 owner 和无法审计的事实竞争。
- 让计划或历史资料成为运行时合同：计划负责执行组织，历史资料不具备产品或架构权威。
- 让 Browser Agent 直接拥有 Page、Cookie、任意 URL 或文件发布能力：这违反 ADR 0017/0023 的受控边界。
- 先实现业务再补对象图和回滚：会把临时实现固化为公共合同，无法证明失败时已提交事实仍然可恢复。
