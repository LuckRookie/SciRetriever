# PDF 获取指南

## 手动 PDF 接纳

用户明确提供的 PDF 可通过 CLI `sciretriever import pdf LITERATURE_ID /absolute/path/article.pdf --json` 或公开 TypeScript `Application.maintenance.ingestPdf({ literature_id, bytes }, signal?)` 接纳。CLI 只读原文件，将字节交给共享维护用例；成功返回包含接纳 ID、SHA-256 和内部相对引用的 receipt。用户原文件不移动、不修改、不删除。目标必须是已有具体 Literature 且尚无当前主 PDF；空文件、无效 PDF 和文章身份无法确认的 PDF 均拒绝，已有主 PDF 不被替换。接纳只发布 `ASSET_READY` 材料，不接着解析或分析，也不调用外部发现/下载。

可从 `@sciretriever/server` 启动 `startMaintenanceWorkbench({ home })` 获得独立本机维护页：`/` 上传 PDF，`/query` 阅读已保存资料。启动前该 home 必须已有 v2 catalog；维护服务不自动迁移用户 catalog。以下命令在安装了该包的 Node 22.19.0 环境中启动服务，按 Ctrl-C 关闭：

```bash
node --input-type=module <<'NODE'
import { homedir } from 'node:os';
import { startMaintenanceWorkbench } from '@sciretriever/server';

const service = await startMaintenanceWorkbench({ home: homedir() });
console.log(service.origin);
process.once('SIGINT', () => {
  void service.close().then(() => process.exit(0));
});
NODE
```

页面不需要 Browser 会话；上传通过同源 cookie/CSRF 和 `POST /api/v1/maintenance/ingest-pdf` 交付最多 16 MiB 的 `application/pdf` 字节，HTTP 不接受路径字段。公开 TypeScript `ingestPdf({ literature_id, bytes }, signal?)` 也执行同一 16 MiB 限额。程序消费者可直接使用上述 TypeScript API。读取端继续使用独立 `createQueryApplication`/`startQueryOnlyWorkbench`；只读入口不会顺便接纳文件。

分析返回 `NoUsableContent`、解析不足、模型失败或取消时，已接纳的 PDF、来源、hash、ParserResult 和旧有效结果保留。补全报告可在失败分区同时列出 `no_usable_content_literature_ids`；durable Job 沿既有兼容映射将这种非系统目标失败记为 skipped，并保留 `completion-candidates-exhausted` 失败码。当前操作不会把该 PDF 当作坏文件重取，也不会伪报 `CONTENT_READY`；稍后明确重试可在相同 PDF 上继续分析。Acquisition 对非 PDF 和身份不确定候选的拒绝仍独立生效。

SciRetriever 对数据库中已经存在的具体 Literature 补全主 PDF。主题发现和引用发现只接纳元数据，
不会顺带下载全文。自动获取的目标合同固定按风险从低到高推进；当前生产接线状态在路线表中单独标记：

```text
Public
  -> Authorized Provider API
  -> Controlled Browser Agent
```

前一层正常结束后仍缺 PDF 的文献才进入下一层；任一路线成功发布主 PDF 后立即停止。网络超时、
临时服务错误、`429`、quota 或 `Retry-After` 不会被解释成“没有 PDF”，也不会触发备用路线绕过。

## 1. 当前获取路线

| 层                                                 | 当前生产能力                        | 主要条件                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public                                             | 已保存的 direct/landing `AssetHint` | URL、redirect、媒体类型和实际 PDF 字节全部重新检查                                                                                                                                                           |
| Public                                             | arXiv、Europe PMC                   | Acquisition Auto 默认启用；Custom 时按精确列表选择                                                                                                                                                           |
| Public                                             | Unpaywall                           | Custom 启用并配置联系邮箱                                                                                                                                                                                    |
| Public                                             | Configured Sci-Hub locator          | 默认关闭；显式启用、Literature 有 DOI，并使用 builtin 或 custom 镜像                                                                                                                                         |
| Authorized API                                     | CORE API v3                         | 启用 `core`、配置 `api_key`，并有 CORE 强记录身份                                                                                                                                                            |
| Authorized API                                     | Elsevier Article/Object Retrieval   | 启用 `elsevier`、配置 `api_key`，并有 PII、Article EID 或确认过的 landing                                                                                                                                    |
| Authorized API                                     | Wiley TDM API v1                    | 启用 `wiley`、配置 `tdm_api_token`，且 DOI 安全落地到 Wiley                                                                                                                                                  |
| Controlled Browser（已接入 Entry；真实站点未核验） | `browser:generic`                   | 低风险路线结束或显式低风险 route declaration、具有安全文章起点，并且 Browser/Model/Profile/runtime/admission 均就绪；已有正式 Entry 的固定 Cloak bundle + loopback PDF 接纳证据，真实 Publisher 仍 `not-run` |

Springer 当前全文 API 产品返回 JATS/XML，不是主 PDF API。Provider key 已配置、认证成功和单篇
文章有全文权限始终是不同事实。

### 补全范围与重试

通过全库、查询、历史发现或 MetaLiterature 范围补全时，系统按版本组处理：先检查同组是否已有版本
达到目标，再按完成度和版本优先级选择候选。因此，查询只命中了预印本，而同组正式发表版已经有主
PDF 时，PDF 补全不会重复下载；普通搜索和书目导出的结果仍是实际命中的版本。

本次目标和候选顺序在操作开始时冻结，后来新增的文献或版本留给下一次操作。已有自动获取耗尽标记
的版本不会因宽范围操作重新请求获取；需要重新尝试时，应明确选择该具体 Literature。取消会保留
已经提交的 PDF，尚未开始的目标进入报告的 `notStarted`；若取消同时发生数据库或发布失败，报告
仍保留该失败，便于区分正常停止和需要处理的系统问题。

批量补全使用普通配置中的 `[execution].max_concurrency`（默认 4，范围 1–64）限制同时处理的
目标数，并按冻结顺序分块。缺 PDF 目标在 operation-local bounded acquisition cohort 中准备，已有
PDF 的目标可以并行准备解析和分析结果，发布事实仍串行完成。Browser delivery 在同一 Application
内经过共享 FIFO lane 串行执行；此设置不增加 Browser 并发，也不表示完整 Public/API/Browser
三级 cohort barrier 已接入。
取消后，已开始且停止的目标进入 `interrupted`，后续块进入 `notStarted`，已提交的 PDF、解析或
内容结果保留。某篇解析或分析失败不会阻止后续块处理。

### Configured Sci-Hub

通过 `sciretriever config` 的 `Download → Sources → sci-hub` 管理镜像，或直接编辑普通配置：

```toml
[sources.acquisition]
mode = "custom"
providers = ["sci-hub"]

[sources.acquisition.sci-hub]
urls = [
  "https://mirror-one.example",
  "https://mirror-two.example/base",
]
```

只把 `sci-hub` 加入 providers 时使用当前版本 builtin mirror set；custom `urls` 一旦存在就完整覆盖
builtin。镜像按顺序而非并发尝试，不自动发现，也不接受 Key、Cookie、session、代理或 selector。
每个 landing/PDF 继续经过共享 Network 和统一 PDF 验收。operator 必须自行确认适用法律、机构政策、
内容许可与服务条款。项目测试只使用保留域名、fake transport 和 fixture，不访问真实 Sci-Hub。

## 2. Controlled Browser 怎样工作

### 生产观看、指导和接管

已有 v2 catalog、已配置 Browser/模型和已验证 Cloak runtime 时，可在安装了 `@sciretriever/server` 的 Node 22.19.0 环境中启动生产工作台。`literature_id` 必须是已存在的具体 Literature；打开页面只建立本机界面，不会开始获取。进入页面后，点击“获取这篇文献的 PDF”才调用同一 Application 的正式 `ASSET_READY` 补全流程：

```bash
node --input-type=module <<'NODE'
import { homedir } from 'node:os';
import { startProductionWorkbench } from '@sciretriever/server';

const service = await startProductionWorkbench({
  home: homedir(),
  literature_id: '替换为已有的 Literature ID',
});
console.log(service.origin);
process.once('SIGINT', () => {
  void service.close().then(() => process.exit(0));
});
NODE
```

工作台可由多个本机客户端观看同一页面。指导会排入有界的进程内队列，每条最多 2048 个 UTF-16 码元，在下一次模型重新观察时作为不可信建议消费；accepted 只表示排队，consumed 表示已交给该次决定。接管会撤销旧模型响应；人工动作使用当前文章、会话、页面和控制版本校验。人类点击产生的 PDF 仍由原 Browser Intake 和 Acquisition 验收、发布，不因“已捕获”就显示为已取得。交还后模型重新观察。控制者断线会暂停新模型动作，需由新连接显式接管并交还；普通观看者断线不改变操作。文章流程的 120 秒硬截止从准入页面打开后起算，包含人工等待；先行 Public/API 阶段也可取消，但不计入文章时钟。取消会停止新增工作并保留已提交的有效事实。下一篇需要新的明确获取操作，旧控制请求和指导不复用。

本入口复用现有同源 Cookie/CSRF 和 loopback HTTP 边界。生产页面在明确开始后显示获取执行中、Browser 已开页、结算和最终五分区报告；目标冻结后显示总数、当前目标和已完成/失败/跳过/未开始/中断计数，没有可观测的 Public/API 阶段总耗时就不估计完成时间。页面候选状态区分已捕获、身份检查和已提交的当前主 PDF；失败或取消后，未提交候选不再显示“等待提交”。操作结束后通过 Library 读取并校验主 PDF 字节，只有校验通过才出现按当前 Literature ID 打开的文献库阅读按钮；已登记文件丢失或损坏时显示不可读，不把 catalog 关系当作可读证明。失败、取消或关闭失败可与已经提交的 PDF 同时出现，阅读按钮仍以校验后的 Library 事实为准。生产工作台的配置页复用同一 Configuration owner，保存普通配置后会提示运行中 Application 是否需要重启。文献库的搜索、详情和 PDF 读取只查询已有资料，刷新不会重新发起获取。当前固定 Cloak bundle、fake 模型和回环站点已验证这条协作与阅读旅程；未验证任何真实 Publisher 的授权和下载。

Controlled Browser 的目标生产对象图不包含 Publisher-specific 点击规则：

```text
route       browser:generic
controller  AgentBrowserController
policy      browser-generic
runtime     one fixed-profile CloakBrowser process/context
```

当前生产 `Application` 在 Browser 显式启用且固定 bundle 验证通过后自动组装 Network proxy/admission，并惰性构造 BrowserHost；缺少 runtime 时稳定不可用。locator 正常耗尽或 route 显式声明低风险不可用、Browser 独立 admitted 时，Entry 才进入受控 Browser delivery。bounded cohort 依次完成 Public、Authorized API 和 Browser/final 波次，按冻结顺序交付各波终态。共享 `BrowserSessionBroker` 按 `operation_id + generation` 拒绝过期排队 delivery；关闭时取消在途并与 host 共同结算。固定 Cloak bundle 的本机 loopback 已覆盖正式 Entry 到 PDF 主关系提交。当前文章请求只允许已接纳 landing 的精确 origin；跨 origin redirect/CDN 被拒绝。真实 Publisher、当前组织权限和跨站资源仍未核验。

Acquisition 从已接纳的 AssetHint 或 DOI safe resolve 形成安全 canonical landing。未知 Publisher 只要
起点通过 Network admission，也可以进入通用 Browser；Publisher profile 不再决定下载资格，只可为
用户显式配置测试提供首页可达性目标。

一篇文章的交接顺序是：

1. Acquisition 形成 `ArticleGoal`，包含文章 token、DOI/标题/作者线索、canonical landing 和安全
   asset hint，不包含 Cookie、secret、签名 query 或 Browser 对象。
2. Network 打开 article-local page，等待页面、frame、popup/viewer 和截图形成同一代稳定
   `BrowserObservation`。加载或页面交接尚未稳定时不会调用模型。
3. Agent 每次只根据一份稳定 Observation 返回一个动作：`ClickElement`、`ClickPoint`、
   `ScrollSurface`、`GoBack`、`WaitForChange` 或 `Stop`。
4. Network 在执行前复核 article、revision、surface 和坐标/元素绑定；过期动作不会落到新页面。
   一次 `apply` 最多执行一个 vendor action，然后等待新的稳定 Observation 或终态。
5. response、native download 和 popup/viewer 可以产生候选捕获，但 capture 本身不是成功。Agent 已
   开始探索后，候选不会把当前 loop 变成 terminal；Browser 保留本次 `BrowserCaptureBatch`，直到
   Agent `Stop`、预算或硬故障结束，再交给 Acquisition。Acquisition 验证实际 PDF 字节、标准
   reader、至少一页页面树，以及 DOI、标题、作者和受控起点等文章归属证据；supplement、冲突 DOI、
   错文和证据不足均拒绝。
6. 只有通过两道验收的候选才以不可变方式发布为唯一 `primary-pdf`。成功、失败、取消或超时后，
   page、handler、临时下载、permit 和运行资源都必须确定性清理。

Agent 不取得 Page/Context、Cookie、Profile、CDP、任意 URL、selector、JavaScript、文件系统或
数据库。它负责“当前稳定页面下一步做什么”；Network 负责“动作是否仍有效并真实执行”；
Acquisition 负责“捕获物是否是目标文章的主 PDF”。

Challenge、登录要求、MFA、无权限、拒绝和未找到都只是普通 `page_state` 描述，不会自动终止 Agent。
Agent 可以用同一六种动作处理当前页面的可见控件，但产品不自动填写登录凭据、选择机构、处理 MFA、注入 CAPTCHA
solver/token 或切换身份/出口。固定 32 次模型决策 safety fuse 只防止实现无限运行，不会被当作
“没有 PDF”。

## 3. 配置与显式测试

推荐使用交互配置中心：

```bash
sciretriever config
# Models → Add: 配置一个 image = true 的 Model
# Browser → Setup: 选择 Model、Profile 和本机资源 cap
# Browser → Runtime: 显式安装或核实 pinned CloakBrowser binary
```

对应普通配置为：

```toml
[browser]
model = "openai/operator-selected-browser-model"
enabled = true
profile = "institutional-access"
max_concurrency = 5
policy_overrides = []
```

`model` 必须引用已经配置且 `image = true` 的完整 `provider/model`；reasoning、image 与 stream 属于
Model 自身，不在 Browser 覆盖。`profile` 是不含敏感信息的 identity，不是路径、账号、机构名、
URL、UUID、Token 或 Cookie 标签。真实 Chromium 状态留在 owner-only Profile 中。

`max_concurrency` 是本机资源 cap，默认 5、必须大于 1；当前 `browser-generic` 自身始终并发 1，
所以提高 cap 不会并行处理多篇 Browser 文章，也不会启动多个 Browser。`policy_overrides` 只接受
`rate_limit_group = "browser-generic"`，并且只能延长间隔、缩小窗口或加强冷却，不能放宽基线。

查看纯本地状态：

```bash
sciretriever config status
sciretriever config status --json
```

状态页显示 Browser Model、固定 Profile、CloakBrowser wrapper/binary、Playwright API、headed
display/Xvfb、唯一 `browser:generic` route 和 `browser-generic` policy。它不启动 Browser、不读取
Profile 内容，也不证明已登录或文章有权限。

Model probe 使用合成 1×1 图片和封闭工具，不访问 Publisher：

```bash
sciretriever config test browser model
```

Publisher site probe 只检查明确目标的首页可达性，不是下载 route，也不打开具体文章或接纳 PDF：

```bash
sciretriever config test browser site acs-publications
sciretriever config test browser site elsevier-sciencedirect
sciretriever config test browser site springerlink
```

可用 access key 是已核实的九个 Publisher 首页。probe 使用已验证 runtime、选中的固定身份
Profile 和同一 BrowserHost/Network 边界；只准入该首页的精确顶层文档，禁用 JavaScript
与下载并阻断其它请求/跳转，也没有 transfer receiver，因此不请求文章 PDF、捕获或发布 PDF。
需要页面资源或跳转的首页可能报告不可达，结果只证明这一收窄的文档可达性。运行时
Chrome 可更新该 Profile 的站点状态，`persisted=false` 只表示没有写入产品事实。passed 仍固定表示
`article_entitlement = not-proven`。

## 4. 结果、失败与重跑

| 情况                               | 含义与处理                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Public 正常未命中                  | 继续 Authorized API，再视条件进入 Browser                                                                                       |
| API 未配置或认证失败               | 明确失败；不由 Browser 静默掩盖                                                                                                 |
| timeout、临时错误、`429`、quota    | 延期或失败；不写自动获取耗尽                                                                                                    |
| Browser 尚在加载或换页             | Network 等待稳定 Observation；不会让 Agent 操作半加载页面                                                                       |
| stale action                       | 不执行旧动作，返回新稳定 Observation                                                                                            |
| 登录/MFA/无权限/拒绝/未找到        | 作为 page state 交给 Agent；只有 Agent Stop 或硬故障后才形成对应稳定结果，不冒充 PDF miss                                       |
| 页面无语义变化、重复动作或短暂不变 | 继续等待/观察，不生成 `no-progress` 终态                                                                                        |
| Candidate timeout                  | 一次内部等待未收敛；Network 隐藏候选状态并把控制权交还 Agent，最终仍无 capture 且 Agent 停止时才作为 `capture-timeout` 失败处理 |
| 捕获到非 PDF、supplement 或错文    | Acquisition 拒绝并清理，不发布主资产                                                                                            |
| 归属证据不足                       | 拒绝或延期，不让模型自行宣布成功                                                                                                |
| runtime/cleanup failure            | 系统失败并熔断 `browser-generic`，不写自动获取耗尽                                                                              |
| Ctrl+C                             | 受控清理；重跑重新读取数据库 current facts                                                                                      |

只有全部适用自动路线都正常结束，且不存在 deferred、action-required、配置、Network、权限或清理
错误时，系统才提交 `NoPrimaryPdf`。后续 Parser/LLM 失败不会撤销已经发布的 PDF。

常用命令：

```bash
sciretriever complete pdf --all-pending --json
sciretriever --debug complete pdf --all-pending --json
```

正常结果写 stdout，进度与日志写 stderr。Debug 会额外记录安全的 Observation、动作、receipt、
capture/identity 验收和 cleanup 线索；实际发给 Agent 的图片保存在系统临时目录
`sciretriever-agent-debug-*`，并用 `manifest.ndjson` 对齐调用序号。图片、prompt、页面正文、完整 URL、
Cookie、Profile 路径和 PDF 字节不会进入 Catalog、仓库或普通日志。
