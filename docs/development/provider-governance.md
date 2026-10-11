# 文献供应商接入与治理

本页说明当前 TypeScript 实现与新增服务的维护入口。长期边界见 [ADR 0014](../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md) 和 [ADR 0012](../architecture/decisions/0012-process-local-provider-access-scheduling.md)。

## 定义与所有权

从 [`providers/README.md`](../../apps/server/src/providers/README.md) 查看目录导航。每家供应商拥有独立目录，静态汇总入口为 [`providers/registry.ts`](../../apps/server/src/providers/registry.ts)：

- `<provider>/definition.ts` 拥有该供应商的能力、认证字段、默认选择、`acquisitionStage`、`publisherAliases`、PDF 适用证据和具体服务声明。`registry.ts` 仅汇总为 `LITERATURE_PROVIDERS` 与 `PROVIDER_SERVICES`，不复制定义。同一供应商可同时提供 Metadata 与 Acquisition；`hints` 表示提供下载线索，没有同名独立下载 adapter。
- 各家 `definition.ts` 的服务声明包含 URL、覆盖范围、quota group、默认并发/间隔/窗口和政策依据。Elsevier 的 Search、Abstract、Article/Object 是不同额度组；CORE 元数据和 PDF 复用同一组。
- `<provider>/metadata.ts`、`acquisition.ts` 和必要的 `locators.ts`/`record.ts` 保存该供应商协议实现，直接使用本目录定义。统一窄接口分别由 `metadata/ports.ts`、`acquisition/ports.ts` 提供；静态注册合同在 `providers/contracts.ts`，真正通用的协议帮助在 `providers/shared/`。
- Metadata registry、普通配置解析、凭据字段校验、安全状态、CLI 和生产 assembly 消费该目录。协议路径、分页和响应解析仍由所属 adapter 负责；不把供应商私有数据格式放进 Network。
- `metadataService` 按真实 API 路径选择产品；`publicWebService` 按下载/跳转的实际目的地选择网页政策，不能用元数据来源决定下载站点额度。

目录不保存 Key、Token、用户身份、当前余额、上次测试结果或文献事实。它不是新核心模块，也不替代配置/凭据 owner。现有用户配置格式和 Auto 选择保持兼容，Key 存在不会自动启用服务。

## 元数据转换：明确协议与局部舍弃

生产 Metadata adapters 先在供应商目录显式映射已支持的 JSON/Atom 字段，再通过
`providers/shared/metadata-values.ts` 处理共同的可选字段，最后进入严格中性合同。
同一规则覆盖 Crossref、Europe PMC、Semantic Scholar、OpenAlex、DataCite、arXiv、OpenCitations、
CORE、Elsevier、Springer 和 Web of Science Starter/Expanded。公开保留的旧 decoder-shell
消费已经符合中性合同的 observation，仍直接严格验证。

| 范围 | 当前处理 |
| --- | --- |
| 文本、日期、年份、计数等可选字段 | 可确定转换则规范化；不支持的值置空，保留其它有效字段。 |
| 作者、单位、关键词、引用文本、资产提示等列表 | 逐项处理，坏项不影响其它项。作者 ORCID 错误只清空 ORCID；单位 ROR 错误只清空 ROR，保留合法姓名/单位名。 |
| 文献标识、来源、版本链接、引用端点 | 不采用可选字段降级规则；必要身份缺失或进入候选的标识不合法时拒绝该记录，保留失败信息。 |
| 响应外壳、必需记录列表、分页控制 | 按所属服务协议验证；错误返回失败，不作为空结果或正常耗尽。 |
| 单条记录错误 | 仍计入原始扫描预算，继续处理预算内其余记录；已有有效 observation 不被丢弃。 |

目前支持的共同规范化包括：文本空白合并与 NFC、标准 ORCID URL、完整非负十进制整数字符串，
以及明确的年/月/日和带时区 ISO 时间戳的日期部分。日期只能保留可信的精度：
`[2024, null, 12]` 得到 `2024`，`2023-02-29` 得到 `2023-02`；不能把日错当月，不能补出缺失日期。
`"2024 draft"` 不猜为年份，未知对象不递归寻找正文，不用 LLM 修复字段。

这不是冻结适配能力。官方协议或有代表性的重复样本证明一种转换能覆盖常见输入，并且含义唯一时，
应增加该转换及正反例测试；共同规则放在 shared，厂商特有形状留在所属 adapter。
没有明确语义或只为一条异常样本成立的猜测，继续在最小字段范围舍弃，不增加通用解释器、配置开关或新持久化状态。

共享字段边界发生舍弃时输出临时 `metadata-optional-field-discarded` 诊断，只包含供应商、字段路径和原因代码，
不输出原始文本、URL 或响应。各家显式映射阶段已经忽略的未知形状不保证产生逐字段诊断；
此日志不是完整的原始字段审计。原始记录 hash 与来源仍随 observation 保存，不因字段舍弃改变。
中性合同与 catalog schema 保持严格且兼容，已存数据不进行迁移。

## 出版社名称维护

Provider 本地 `publisherAliases` 保存明确已知别名；用户确认的扩展由唯一普通配置 owner 保存：

```toml
[sources.publisher_aliases]
elsevier = ["Local Publishing Name"]
```

此可选字段缺省为空，旧配置可继续读取，不迁移 catalog。`resolvePublisherNames(name, aliases?)` 支持注册 Provider ID、Unicode NFKC、空白合并和大小写归一，只执行明确映射，不模糊猜测。名称解析用于服务候选；文章级站点/专用标识和实际 entitlement 判断继续独立。来源 observation 的出版社/期刊原文与 Literature 身份不被映射覆盖，期刊无需先登记。

名称解析唯一命中一个 Provider ID 时，只把当前 publisher-api 阶段中已选中的同名来源稳定排到前面；其余来源仍保持配置顺序，未知或冲突不改变优先级。此调整不删除来源、不自动启用服务，实际调用仍须通过 `authorizedTargets` 的文章级站点/专用标识证据。

显式维护入口分别负责扫描/建议和接纳：

```bash
sciretriever maintenance publisher-names --all
sciretriever maintenance publisher-names --literature-id LITERATURE_ID --ai --max-ai-requests 20 --output /absolute/path/publisher-report.json
sciretriever maintenance publisher-names --query 'local query' --scan-limit 10000
sciretriever maintenance publisher-names-accept --report /absolute/path/publisher-report.json --name 'normalized name'
```

范围必须从 `--all`、可重复的 `--literature-id` 或 `--query` 中选择一个。扫描默认上限 10000、允许 1–100000，按 200 条分页；到达上限时报告 `complete=false` 与 `next_cursor`，可以用 `--cursor` 续扫。显式 ID 范围不支持 cursor，数量不能超过 scan limit。报告始终为 JSON；可选 `--output` 使用 create-if-absent 导出，不覆盖已有文件。

报告按规范名称分组，保留 `raw_names` 原文及文献数量、来源名、站点支持的 Provider ID 和最多五个有界样本；解析状态为 resolved、unknown 或 conflict。默认不调用模型；`--ai` 使用当前 Analysis Model，每批最多 20 个未知名称，默认最多 20 次请求，`--max-ai-requests` 允许 1–100。没有处理到的条目保留 request-limit，模型错误保留 `ai_failure`；建议记录输入 hash 与模型 provenance，不把模型置信度当作接纳依据。

扫描/建议不会自动写别名、修改来源、联网核验出版社或下载 PDF。`publisher-names-accept` 只处理显式选中的 `--name`（可重复）；`--report -` 可以从 stdin 读取报告。接纳要求 unknown 条目有非空且无失败的建议，验证注册 ID、站点与已有别名冲突，再依据报告的 `configuration_revision` 原子更新普通配置；配置已变更时拒绝旧报告，不能覆盖并发修改。新 Application/获取任务读取接纳结果，后续可通过配置 owner 或人工编辑同一配置纠正。报告不是新的文献事实表，也不自动创建后台治理任务。

## 获取阶段与运行态线索

来源在所属 `definition.ts` 声明 `acquisitionStage`：arXiv/Europe PMC 为 direct，Elsevier/Wiley 为 publisher-api，CORE/Unpaywall 为 general-api，Sci-Hub 为 public-web；通用 Direct 与 DOI landing 分别为 direct 和 public-web。认证类别独立保留，`splitAcquisitionRoutes().stages` 按阶段提供 registry，旧认证分组继续兼容。不可用的已选来源保留失败，不能因拆阶段静默丢弃。

Direct 只消费已有受支持资产线索，PDF 媒体类型/主 PDF 角色和 pathname `.pdf` 后缀均可发现候选；角色/版本排除、query 与凭据边界继续执行。实际 PDF 字节由同一 reader 验证；授权 API 返回错误媒体类型也不能使已经取得的 PDF 重复请求，XML/JATS 不冒充 PDF。

共享下载器的 `on_response` 在真实 transport 响应返回、失败分类前报告临时 requested/final URL、status 与 media type，保留旧 `on_landing`。Entry 只在当前操作复用这些结果与 DOI 定位证据来准备后续服务/Browser 入口，不持久化或打印敏感 URL，不另发常态 HEAD/GET；普通 HTTP 403/404 不是跨传输的永久坏链判定。Browser 首次模型前有限恢复共享同一 clock，详见[PDF 获取指南](../guides/pdf-acquisition.md)。

DOI 定位只对 doi.org 发出一次 GET。首跳响应由当前操作保存并复用：实际 PDF 立即交统一下载验收和发布，成功后跳过剩余 API/网页；200 HTML、403/404、缺少可用 Location 或回到同一 DOI 的响应也不重复 GET，后续公共下载器消费原响应并沿原错误/静态解析规则处理。确认了不同且安全的 landing 才丢弃首跳缓存并改用该入口。响应字节预算复用公开 PDF 的默认 64 MiB 上限，状态或敏感响应不进入长期事实；即使已交付 PDF 带 Retry-After，已有字节可以验收，而共享 Network 冷却仍执行。

普通 HTTP landing 可以作为经准入的 Browser 入口；无凭据公共下载器仍只处理 HTTPS，不把 HTTP 地址交给 HTTPS 下载器触发内部类型错误，也不因此放宽网络协议或凭据策略。

## 限流的当前实现

`NetworkBudgetCoordinator` 在同一进程内按 quota group 维护活动请求、最小启动间隔、多个 rolling windows 与阻塞截止。host 并发是附加资源约束，不能代替供应商额度组。两种能力共享组时一起计数，不同产品的窗口保持独立。

数值依据来自 `docs/notes/providers/` 中已保存的外部资料；本次治理没有重新联网核验政策。目录的 `policyBasis` 区分供应商数值与项目保守策略。未知普通网页当前采用单并发、1 秒启动间隔；未知 API 政策分量采用同一保守基线。具体服务的明确规则覆盖默认分量，例如 arXiv 3 秒、Wiley 60 次/10 分钟、DataCite 500 次/5 分钟。

普通 HTTP 每个重定向和静态链接请求重新选择目的地政策。`Retry-After` 在响应头到达、当前 permit 释放之前反馈整个额度组；无该头的 429 按目录默认退避 60 秒。无 Retry-After 的 HTTP 5xx 按服务 `serverErrorBackoffMs` 退避，项目默认 30 秒；每个目标与重定向落点共享实际目的地的额度组。这是本地故障退避，不伪造远端 Retry-After 或限流原因。等待比单次请求预算还长时保留 429/退避信息返回，不发起必然超时的内部重试。当前沿用 HTTP 层有界 `Retry-After` 上限，不宣称已实现任意长账户 reset deadline。

窗口只统计本进程发出的请求。日/周 rolling window 是保守本地限制，不等同于真实账户剩余额度，也不跨进程或重启持久化。CORE token cost、OpenAlex 调用成本、WoS Full Record allowance 没有被伪装成每请求一个单位；当前不完整解析供应商所有专有 quota/reset 响应头。账户政策变化需要按对应外部合同维护，不能凭 Key 存在推断套餐。

Browser 继续使用通用动作流程与独立的平台文章准入：动作结束后至少 5 秒、同平台实际网络结束后冷却 30 秒。HTTPS CONNECT 隧道是连接容量，不是逐网页请求计数。本次未将普通 HTTP 的服务窗口伪接到隧道上，也未声称完整实现 Browser 子资源的各站请求额度。Browser 的进一步平台政策接线须保持精确请求归属与下载生命周期。

## 接入或修改一个供应商

1. 在所属 Provider Note 保存官方来源、核对日期、产品边界、认证和额度依据，未知项明确标记。
2. 在 `providers/<provider>/definition.ts` 维护唯一服务声明，并在中央注册。区分元数据、全文线索与真正 PDF 能力，声明文献定位所需证据；不要仅凭 publisher 字符串或 DOI 前缀证明权限。
3. 在同一供应商目录实现 Metadata 或 Acquisition 的窄接口，并在所属 assembly 组装，复用 Network 和凭据 owner。禁止另设私有 sleep/limiter 或绕开网络准入；也不为了文件名对称给不支持的能力制造空实现。
4. 验证配置显示、实际能力与生产对象图一致；使用 fake/loopback 覆盖范围外文献、凭据撤销、跨能力共享额度、独立产品、重定向、限流、取消及不可变入库。
5. 同步当前指南并运行相关测试与 Full。若需要改变已支持配置或数据库格式，先遵循项目授权与兼容规则。

目录给出“支持什么、默认怎么访问”，实际服务器决定“本次是否可用、是否授权”。一次成功下载或本地凭据存在均不能覆盖后一个判断。
