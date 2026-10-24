# PDF 获取指南

类型：指南
负责：PDF 自动获取、人工接纳与失败排查
状态：现行

公开文献优先通过普通 HTTPS 下载；arXiv 直接使用 PDF URL，成功后不启动 Browser 或调用 Browser
模型。受控 Browser Agent 用于前四层仍未取得 PDF 且结果允许继续的目标，通过当前机器
的网络出口、机构 IP 和浏览器会话访问出版社文章页；具体文章是否可读以实际结果为准。

## 手动 PDF 接纳

用户明确提供的 PDF 可通过 CLI `sciretriever import pdf LITERATURE_ID /absolute/path/article.pdf --json` 或公开 TypeScript `Application.maintenance.ingestPdf({ literature_id, bytes }, signal?)` 接纳。CLI 只读原文件，将字节交给共享维护用例；成功返回包含接纳 ID、SHA-256 和内部相对引用的 receipt。用户原文件不移动、不修改、不删除。目标必须是已有具体 Literature 且尚无当前主 PDF；空文件、损坏或不符合当前非加密可读合同的 PDF 拒绝；文章身份尚未确认不阻止接纳，已有主 PDF 不被替换。接纳只发布 `ASSET_READY` 材料，不接着解析或分析，也不调用外部发现/下载。

可从 `@sciretriever/server` 启动 `startMaintenanceWorkbench({ home })` 获得独立本机维护页：`/` 上传 PDF，`/query` 阅读已保存资料。启动前该 home 必须已有当前结构的 catalog；维护服务不自动迁移用户 catalog。以下命令在安装了该包的 Node 22.19.0 环境中启动服务，按 Ctrl-C 关闭：

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

`complete parser` 显式获取缺少的主 PDF，并生成部署 profile 的一份原始解析；不生成总结或默认阅读文档。解析不足、失败或取消时，已接纳的 PDF、来源、hash 和成功的原始解析保留。补全报告通过五个互斥分区及稳定失败码表示结果，不再包含旧总结清理字段。稍后明确重试会复用成功的 profile；解析失败不会把 PDF 当作坏文件重取。Acquisition 对非 PDF、损坏或不可读文件的拒绝仍独立生效，文章身份未验证不阻止接纳。

SciRetriever 对数据库中已经存在的具体 Literature 补全主 PDF。主题发现和引用发现只接纳元数据，
不会顺带下载全文。自动获取使用以下顺序，认证要求与阶段分别表示：

```text
已有直链 / 稳定公开 PDF 地址（direct）
  -> 出版社专用 API（publisher-api）
  -> 聚合 / 开放获取 API（general-api）
  -> 公共网站（public-web）
  -> Browser Agent
```

前一来源正常未命中或发生 HTTP/API 请求、认证、权限、服务、外部响应格式错误时，仍缺 PDF 的文献继续后续独立渠道；任一路线成功发布主 PDF 后立即停止。候选 URL 被网络策略拒绝、PDF 文件不可读只拒绝当前候选。`429`、quota、`Retry-After` 停止本来源的剩余候选并保留服务冷却，其它服务继续；同一额度组/平台限制仍由共享 Network 执行。若后续均未取得文件，保留原故障，不记录自动耗尽。人工协助在自动渠道尝试结束后应用；取消、存储/发布和内部合同错误仍停止相关执行。

## 1. 当前获取路线

供应商、具体服务和能力是不同维度。各服务的 URL、适用证据、认证要求与默认访问政策统一由生产目录提供；只有全文链接能力的元数据来源通过通用 hint 路径下载，不会因此成为独立 PDF API。当前共享限流和维护边界见[供应商治理](../development/provider-governance.md)。

| 阶段          | 当前来源                | 主要条件                                                                                                        |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| direct        | 已保存的 PDF 线索       | 明确 PDF 媒体类型/主 PDF 角色或 pathname 的 `.pdf` 后缀；排除补充材料、其它角色与目标版本冲突，实际字节仍须验证 |
| direct        | arXiv、Europe PMC       | Auto 默认启用；由 arXiv ID、PMCID 生成公开 PDF 地址，PMID 本身不生成地址                                        |
| publisher-api | Elsevier Article/Object | Custom 启用、配置 `api_key`，且有 PII、Article EID、匹配文章提示或确认过的 landing                              |
| publisher-api | Wiley TDM               | Custom 启用、配置 `tdm_api_token`，唯一 DOI 与 Wiley 文章访问证据绑定                                           |
| general-api   | CORE                    | Custom 启用、配置 `api_key`，并有 CORE 强记录身份                                                               |
| general-api   | Unpaywall               | Custom 启用并配置联系邮箱；返回的文件 locator 立即下载                                                          |
| public-web    | DOI/文章 landing        | Network 逐跳复检后解析静态 PDF 声明或链接，相对地址基于实际落地页                                               |
| public-web    | Sci-Hub locator         | 默认关闭；显式启用、有 DOI，使用 builtin 或 custom 镜像                                                         |
| browser       | `browser:generic`       | 前四层结果允许继续、有安全入口且 Browser/Model/Profile/runtime/admission 就绪；本地就绪不证明文章权限           |

Custom 精确选择来源，在同一阶段内以配置顺序为基础，出版社 API 可按唯一名称候选稳定优先；阶段顺序固定。CORE 与 Unpaywall 同层，但凭据要求不同。已选中却缺参数、凭据或适配器的来源会报告失败，不能被静默当作正常耗尽。

`.PDF`、`.pdf?download=1` 都可以形成候选；无后缀但明确为 PDF 的地址同样可用。只处理受支持资产线索，保留 query，移除阅读器 fragment；文件有效性由字节与 PDF reader 决定。任一层取得 locator 后立即沿对应机制下载，有效文件不重新排到 direct，不因错误的 Content-Type 重取；本地发布失败保留有效候选。

已知授权 API 的 PDF 提示不会被 Direct 当作匿名直链请求，既有 observations 中误标为
`open` 的提示也遵守这条规则。Crossref 链接本身不证明开放获取，新增提示的访问状态为
`unknown`。出版社 API 缺少定位证据时，可以先做一次有界 DOI 定位；这只确认访问方，不提前执行公共网页全部下载策略。取得的 landing 和实际响应只在本次操作复用，不保存敏感跳转参数。定位失败保留证据并继续独立渠道；Sci-Hub 等 DOI 来源和 Browser 不依赖前一 API 成功。未知内部错误仍停止相关执行。

DOI 定位只对 doi.org 发出一次 GET。首跳响应由当前操作保存并复用：实际 PDF 立即交统一下载验收和发布，成功后跳过剩余 API/网页；200 HTML、403/404、缺少可用 Location 或回到同一 DOI 的响应也不重复 GET，后续公共下载器消费原响应并沿原错误/静态解析规则处理。确认了不同且安全的 landing 才丢弃首跳缓存并改用该入口。响应字节预算复用公开 PDF 的默认 64 MiB 上限，状态或敏感响应不进入长期事实；即使已交付 PDF 带 Retry-After，已有字节可以验收，而共享 Network 冷却仍执行。

普通 HTTP landing 可以作为经准入的 Browser 入口；无凭据公共下载器仍只处理 HTTPS。元数据提供的 HTTP PDF 直链同样按当前 HTTP 路线不可用处理，继续其它已配置来源和 Browser，不触发中断整批任务的内部类型错误，也不因此放宽网络协议或凭据策略。

Elsevier 可以消费 PII/EID、Article API 提示或确认过的文章 landing 与唯一 DOI，先请求
`/content/article/{doi|pii|eid}/{identifier}?view=FULL`，再取 FULL XML 中 MAIN PDF 的 attachment
对象；预览图片的嵌套字段不当作主文件字段。Wiley 可以消费与唯一 DOI 绑定的 TDM 提示、
Wiley Online Library 及其子域的页面证据；TDM 请求只允许官方 ALM 下载路径的一次跳转，
跨 origin 不携带 TDM token，下载 locator 不进入 provenance。API key 存在仍不会自动改变
Auto/Custom 选源。

Springer 当前全文 API 产品返回 JATS/XML，不是主 PDF API。Provider key 已配置、认证成功和单篇
文章有全文权限始终是不同事实。

有效的 `2xx` landing HTML 没有静态 PDF 链接属于正常未命中。公共 HTTP `403`、静态链接只返回非 PDF 表示、明确的重定向上限且没有限流反馈，表示该 HTTP 路线不能完成，可以继续已配置的 API 与 Browser；不据此判断机构版权。标为 PDF 直链的地址返回 HTML 时也尝试通用静态 PDF 链接，实际 PDF 字节不因错误的 Content-Type 被拒绝。`401`、`429`、Retry-After、候选地址拒绝、5xx、连接/请求失败、超时或响应中断均保留原因并允许独立来源继续；限流只停止本来源的备用候选，共享服务/平台冷却仍有效。这些失败及冷却仍是未解决结果，后续未命中不能覆盖它们；内部合同异常不按来源失败吞掉。静态 PDF 声明或链接中的阅读器 fragment（例如 `#view=FitH&navpanes=0`）在请求前去除；实际路径、query、origin 和 DNS 仍经过原安全检查，不执行脚本或任意表单。主 PDF 接纳检查字节、PDF结构、页数与当前非加密可读合同，不匹配正文中的
DOI、arXiv ID或标题；有效文件正常发布并标为文章身份未验证。后续解析阶段可另行检验身份。

### 出版社名称与维护

已知别名和用户明确接纳的 `sources.publisher_aliases` 帮助提出服务候选。Scopus 返回某篇文章不表示 Elsevier 拥有原文；名称归类也不证明具体文章授权。文章站点、专用标识与实际服务结果仍决定 API 适用性。未知/冲突名称不阻断已知直链或独立可用路线，也不要求先登记期刊。

名称解析唯一命中一个 Provider ID 时，只把当前 publisher-api 阶段中已选中的同名来源稳定排到前面；其余来源仍保持配置顺序，未知或冲突不改变优先级。此调整不删除来源、不自动启用服务，实际调用仍须通过 `authorizedTargets` 的文章级站点/专用标识证据。

需要批量整理名称时，显式运行 `maintenance publisher-names`，可选择 AI 建议后再单独接纳；不会在每次下载中调用治理模型或覆盖来源原文。完整命令、扫描预算和配置示例见[出版社名称维护](../development/provider-governance.md#出版社名称维护)。

### 补全范围与重试

通过全库、查询、历史发现或 MetaLiterature 范围补全时，系统按版本组处理：先检查同组是否已有版本
达到目标，再按完成度和版本优先级选择候选。因此，查询只命中了预印本，而同组正式发表版已经有主
PDF 时，PDF 补全不会重复下载；普通搜索和书目导出的结果仍是实际命中的版本。

本次目标和候选顺序在操作开始时冻结，后来新增的文献或版本留给下一次操作。已有自动获取耗尽标记
的版本不会因宽范围操作重新请求获取；需要重新尝试时，应明确选择该具体 Literature。取消会保留
已经提交的 PDF，尚未开始的目标进入报告的 `notStarted`；若取消同时发生数据库或发布失败，报告
仍保留该失败，便于区分正常停止和需要处理的系统问题。

批量补全使用普通配置中的 `[execution].max_concurrency`（默认 4，范围 1–64）限制同时处理的目标数。
目标集合在开始时冻结；worker 完成一篇立即领取下一篇，不再等待固定批次的最慢目标。
每篇独立按 direct、publisher-api、general-api、public-web、Browser 顺序获取，实际请求仍服从各来源配额。
单篇进度按完成时刻反馈，最终报告保持冻结目标顺序。已有 PDF 可继续解析/分析，提交仍经操作内串行边界。
同次操作的 ID 和代次稳定，加入新目标或某篇恢复不会使其他下载过期。

Application 共享 Browser 调度器默认有两个决策 worker、最多五个保留会话。后台下载释放模型 worker，
仍占该篇保留会话和平台网络资格；不同平台可并行，同平台一篇文章有网络活动，网络结束后冷却 30 秒。
外层目标容量、会话 cap、平台与模型限额同时生效，持续补位不会绕过它们。
取消停止新目标并等待已启动目标收尾；未启动目标进入 `notStarted`，已提交事实保留。
普通单篇失败不阻止其他目标，存储/发布完整性错误仍停止相关操作。

Browser 的 INFO 日志提供传输、Intake 和发布分段时间，包含 article/session/transfer ID、phase、
单调时钟 `elapsed_ms` 与累计字节；进度最多每 10 秒随新增字节记录一次。各 owner 从自己的开始时刻计时，
不能直接相加；`first-byte` 表示首次观测到字节。日志不含 URL、页面内容、Cookie 或凭据。

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

已有当前结构的 catalog、已配置 Browser/模型和已验证 Cloak runtime 时，可在安装了 `@sciretriever/server` 的 Node 22.19.0 环境中启动生产工作台。`literature_id` 必须是已存在的具体 Literature；打开页面只建立本机界面，不会开始获取。进入页面后，点击“获取这篇文献的 PDF”才调用同一 Application 的正式 `ASSET_READY` 补全流程：

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

工作台可由多个本机客户端观看，并显式选择文章会话。会话列表区分排队、浏览、下载、文件检查、候选就绪和关闭结果；切换前台视图不会改变下载归属。指导会排入所选会话的有界队列，每条最多 2048 个 UTF-16 码元，在下一次观察时作为不可信建议消费。接管会撤销该会话的旧模型响应；人工动作按文章、会话、页面和控制版本校验，人工下载仍进入同一 Intake 和正式发布。交还后重新观察，控制者断线会暂停该会话的新模型动作。

每篇使用同一个累计预算：300 秒活跃操作、30 次实际模型派发，先到上限就停止进一步探索。动作次数保留统计，默认不另设上限。最后一次合法调用仍可执行动作、完成既有有界页面反馈与下载交接，但时间及控制版本检查继续生效；已经开始的文件传输使用独立下载寿命。平台排队、后台下载和文件验收/发布不消耗活跃操作时间；恢复不会重置预算。动作结束到下一次模型决策至少 5 秒。可单独取消排队或执行中的文章，其他文章继续；取消整次操作则停止所有未完成目标，已提交事实保留。会话另有 60 分钟保留寿命，避免无限等待。预算旨在覆盖大多数正常任务，约 90% 是待真实样本检验的目标，允许舍弃少数复杂或当前无权限的任务；预算耗尽不会登记为永久无版权或全渠道耗尽。

本入口复用现有同源 Cookie/CSRF 和 loopback HTTP 边界。生产页面在明确开始后显示获取执行中、Browser 已开页、结算和最终五分区报告；目标冻结后显示总数、当前目标和已完成/失败/跳过/未开始/中断计数，没有可观测的 Public/API 阶段总耗时就不估计完成时间。页面候选状态区分已捕获、文件检查和已提交的当前主 PDF，并显示“文章身份未验证”；失败或取消后，未提交候选不再显示“等待提交”。操作结束后通过 Library 读取并校验主 PDF 字节，只有校验通过才出现按当前 Literature ID 打开的文献库阅读按钮；已登记文件丢失或损坏时显示不可读，不把 catalog 关系当作可读证明。失败、取消或关闭失败可与已经提交的 PDF 同时出现，阅读按钮仍以校验后的 Library 事实为准。生产工作台的配置页复用同一 Configuration owner，保存普通配置后会提示运行中 Application 是否需要重启。文献库的搜索、详情和 PDF 读取只查询已有资料，刷新不会重新发起获取。固定 Cloak bundle、合成模型响应和回环站点用于重复验证这条协作与阅读旅程；真实模型及出版社逐篇结果见本轮验证记录（本地文件：`sandbox/reports/browser-parallel-validation-2026-10-05.md`，不随仓库分发），单个样本成功不代表该平台所有文献均有权限。

Controlled Browser 的目标生产对象图不包含 Publisher-specific 点击规则：

```text
route       browser:generic
controller  AgentBrowserController
policy      browser-generic
runtime     one fixed-profile CloakBrowser process/context
```

当前生产 `Application` 在 Browser 显式启用且固定 bundle 验证通过后自动组装 Network proxy/admission，并惰性构造 BrowserHost；缺少 runtime 时稳定不可用。前四层未取得 PDF（包括正常未命中和来源局部失败），且 Browser 独立 admitted 时，Entry 进入受控 Browser delivery。生产 Completion 的每篇目标独立完成五层顺序并及时交付终态，空闲目标槽持续补入后续文献。共享 `BrowserSessionBroker` 按 `operation_id + generation` 拒绝过期排队 delivery；关闭时取消在途并与 host 共同结算。固定 Cloak bundle 的本机 loopback 已覆盖正式 Entry 到 PDF 主关系提交。后续请求必须属于当前文章的活动 page/frame；关联资源和重定向可以使用其它 origin，但每次仍经过 Network 的协议、DNS、公网地址和端口检查。离线 Cloak 用例覆盖跨 origin CSS、JavaScript 和 PDF 下载；具体出版社权限仍需逐文章核验。

当前 Browser 入口来自适合目标版本的资产线索、当前操作已经取得的实际 landing，以及受控 DOI resolver。软件复用前四层响应、去重并排序有限入口，未知 Publisher 也可以按同一 Network admission 进入通用 Browser。PDF 下载端点与文章页面分别保留：普通 HTTP 403/404 不会永久禁用 Browser，也不会因下载端点失败丢弃仍可用的文章页面。此准备不增加一轮 HEAD/GET，不由模型猜测 Publisher URL。

所有入口只调用一次逻辑 Browser delivery，共用同一文章 clock、计数与页面。首次实际模型请求前，程序开页、等待、观察；原生下载可以零模型完成。只有 Browser 实际 404/410 或 Host 已分类的 DNS/连接失败，才在有限列表中尝试尚未访问的备用入口；403、验证页或未知 HTML 交给模型。换入口前先结算真实在途捕获，已经开始下载就沿原传输继续；实际到达地址参与去重，保留有意义的 query。首次模型派发后不再后台自动换入口。备用导航继续遵守 5 秒节奏、目标平台准入和冷却，开页与观察消耗同一活跃预算，取消后不启动备用。

实际导航保留通过准入的文章查询参数，例如 `?id=...`；页面观察、对外 URL 和持久证据继续去除 query。
Browser 使用 Chromium 的原生下载处理顶层 PDF，避免把内置 PDF viewer 的 HTML 当作 PDF 字节。
原生下载得到的候选仍需经过同一 PDF 文件检查和不可变发布，文章身份标记为未验证。

跨平台导航先结清旧页面的网络活动，再申请目标平台资格。如果旧子资源阻塞交接，已准入的 GET
可以在同一页面内进行一次受控恢复：取消尚未发送的新导航，确认旧请求真实结束后重新导航。
这不重置文章预算，也不绕过冷却；POST 不自动重放。已经开始的 PDF 传输优先完成，不能被导航恢复取消。
旧文档的普通资源与独立下载分别结算；仍被浏览器保留的原响应需要真实 EOF 或取消确认才能释放网络资格。
不同浏览器运行环境可能报告不同的结束事件，代码按精确请求的终态处理，不把等待超时或标签页消失直接当作下载结束。
开页尚未完成也受单篇活跃预算控制；预算到期关闭该篇的现场，其它文章继续。合法的PDF弹窗可以先于下载事件关闭，
迟到下载仍归原文章；整篇已关闭的迟到下载会取消，不会重新入库。连接故障只对有精确授权与失败证据的同URL GET重试一次，
不会根据已经重定向失效的起点许可反复重放DOI。

普通推理与上下文压缩都计入同一文章的真实模型派发次数和活跃时间；排队取消或预算拒绝不发送请求、不增加次数。会话恢复、人工交还或下载失败恢复不会重置探索预算。模型压缩只改变临时对话的输入投影，不成为文献事实或文件成功证据。

一篇文章的交接顺序是：

1. Acquisition 从当前冻结的 Literature 元数据选择文章 landing，并生成有界的
   `BrowserArticleGoal`（Literature ID、稳定标识、版本、标题、作者、摘要片段、期刊/出版社、年份和
   文献类型）交给 Browser。每篇文章保留独立的临时模型会话。模型每步接收这份目标、当前页面观察、最新截图和此前工具调用/结果；旧图在模型输入中改为引用说明，原图随会话保留到关闭。没有 Cookie、secret、签名
   query 或 Browser 对象。目标元数据只用于识别文章和判断页面是否相关，不能被模型转换为新的 URL。
2. Network 打开 article-local page，等待页面、frame、popup/viewer 和截图形成同一代稳定
   `BrowserObservation`。可读页面无需等待所有子资源完成；导航销毁上下文时重新观察。
3. Agent 根据当前稳定 Observation 和同篇历史调用受控动作工具。一次模型响应可能包含多个调用，但程序对这份观察至多接纳一个页面动作，其余调用记录拒绝结果。允许动作是：`ClickElement`、`ClickPoint`、
   `ScrollSurface`、`GoBack`、`WaitForChange` 或 `Stop`。
   模型主动停止只提供两类原因：`access-unavailable`（当前文章的访问确实需要付费、不可用登录或身份验证，且无可用替代入口），以及 `no-viable-path`（合理的文章相关路径已尝试，没有新的有效下一步）。每次停止附一句具体尝试与障碍说明；慢页面、单次点击失败、验证码或单个登录/购买按钮都不能单独成为退出理由，误入无关页面应先返回文章。说明进入最终失败报告，不成为机构无版权或全渠道耗尽的永久事实。取消、超时和真实网络错误仍由程序处理。
4. Browser 在执行前复核 article、revision、surface 和坐标/元素绑定，过期动作不能落到新页面。每次只执行一个模型动作，随后等待页面变化；下一轮模型派发还必须满足动作结束后至少 5 秒的间隔，两段等待重叠。挑战页和疑似下载继续使用较长反馈观察窗口，内部等待不额外记为 Agent 动作。

   等待比较主页面及可见 iframe（含跨 origin 与嵌套 frame）的可见文本、控件出现/可用状态、文档状态；纯 CSS 变换或像素动画不会反复唤醒模型。返回明确区分检测到变化与超时未检测到变化，检测到变化也不等于访问障碍已解决。连续无变化等待的次数和实际等待时长进入同篇工具结果及下一轮反馈，模型据此重新检查控件和待完成的跳转，并在合理路径已尝试且无新路径时使用既有 `no-viable-path`。不新增自动早退阈值，超时不等于无权限。显式等待完成后仍需至少 5 秒才可再次决策；点击后的自动反馈等待与该间隔重叠。此反馈不是完整视觉理解，纯 canvas/图片内部变化仍由后续截图判断。

5. 原生下载、明确 attachment 的 PDF response 和 popup/viewer 的真实下载事件按 session/page/operation/generation 关联。普通 Fetch/XHR inline PDF 继续用于页面渲染，后台预览不会抢先结束正文探索；Agent 可继续点击正文或 viewer 的下载控件。每篇只保留一个主下载；下载开始后暂停该篇模型决策，保留原文章现场并释放 worker，让其它符合条件的文章继续。HTTP 和 CDP 原请求响应按块转发/落盘，不另发无浏览器身份的 GET。
6. Acquisition 通过受控文件句柄检查实际 PDF 可读、至少一页和当前非加密合同；不匹配 DOI、标题、作者或版本。下载/文件检查失败将具体原因送回同一文章及模型会话，按原预算重新观察。网络结束先释放平台资格并开始冷却，本地验证不继续占用出版社网络资格。
7. 有效候选交给正式 acceptance/publication，发布为唯一 `primary-pdf` 并标记文章身份未验证，然后关闭文章会话。单篇取消信号继续传到文件检查与提交前检查；取消已完成下载但尚未发布的候选时保留有效字节，不再自动发布。应用关闭会停止新工作、取消在途检查并等待实际 reader/下载写者退出，再释放文件与数据库。本地 publication 失败保留有效候选及恢复信息，不让 Agent 重新下载；发布成功后的页面关闭故障独立报告，不撤销已提交的资产。

Browser 文件链按实际资源管理，不再用 16 MiB 或 512 MiB 的单文件常量拒绝大型 PDF。默认临时总额 4 GiB（含原生原件、staging 和发布准备副本），保留磁盘余量 1 GiB；单项传输连续 120 秒没有新增字节或总计达到 20 分钟会取消并报告原因。原生字节进度存在观测延迟，因此这些是运行保护值，不是内核强制的精确磁盘配额。公开/API 和手动 PDF 的显式 bytes 入口仍保留其已有大小边界。

`browser.max_concurrency` 默认 5，允许 1，实际会话上限为 `min(配置值, 8)`；worker 数为 `min(2, 有效会话数)`，同时受共享模型网络预算约束。旧 `browser-generic` 的显式 `max_concurrency=1` 仍使整个文章会话全局串行；其 start interval/window、完成/失败/限流冷却和运行故障阈值与平台政策一起执行。配置界面和 doctor 显示配置值、生效值及限制原因，不改写用户配置。

Agent 不取得 Page/Context、Cookie、Profile、CDP、任意 URL、selector、JavaScript、文件系统或
数据库。它负责“当前稳定页面下一步做什么”；Network 负责“动作是否仍有效并真实执行”；
Acquisition 负责“捕获文件是否为有效 PDF、是否属于本次任务、是否正常发布”。

文献详情中的 `primary_pdf.article_identity_status` 为 `unverified`；这表示文章内容身份尚未检验，
不是文件损坏或下载未完成。人工接纳与公开/API 下载遵循同一原则。后续可以在解析阶段增加身份检验，
当前解析完成不会自动变更该标签，也不会因标签存在而阻断解析。

Challenge、登录要求、MFA、无权限、拒绝和未找到都只是普通 `page_state` 描述，不会自动终止 Agent。
当 `page_state=CHALLENGE` 时，Agent 只能根据当前 Observation 或截图点击可见的 `Verify`、`I'm human`
或 `Continue` 控件，然后用 `WaitForChange` 重新观察；它不取得 iframe selector，也不注入 CAPTCHA
solver/token、脚本或其它绕过。Browser 层会在 challenge 点击后强制先等待一次页面交接；如果页面语义仍未变化，后续重复点击会被抑制为等待，直到新反馈、Agent Stop 或硬预算。普通文章导航里的被动 `Sign in` 文案不会单独判定为登录门禁，只有“登录后才能访问/继续/查看全文”等明确提示才会进入 `LOGIN_REQUIRED`。可跟随页面为当前机构会话提供的访问/继续按钮；不会自动填写登录凭据、选择新的机构身份、处理 MFA 或切换身份/出口。当前通用 flow 使用上述累计 300 秒与 30 次真实模型派发预算。

浏览器可跟随页面提供的 HTTP/HTTPS、跨域临时下载链接和编码路径；DNS/IP/端口检查仍生效，
query/fragment 不进入模型或持久来源。页面生成的 multipart 表单可正常提交，Agent 仍不能选择或上传本地文件。新标签页无历史可退时，GoBack 返回打开它的文章标签页。TLS 隧道使用独立连接生命周期；活动流量不会因为长连接
超过单次请求时长被切断。429 按已归属响应反馈给共享平台调度，至少退避 60 秒，并遵守更长 Retry-After/配置冷却；同会话重新获准后仅对适用 GET 重试一次，否则明确报告
`browser-rate-limited`；连接失败报告 `browser-navigation-failed`，后续可以显式重试。
单页关闭或崩溃分别保留 `browser-page-closed` / `browser-page-crashed` 原因，只结束所属文章；共享浏览器失联才报告 `browser-runtime-lost` 并停止所有未交付会话。已提交 PDF 不因随后页面或运行时故障撤销。

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

`max_concurrency` 控制保留文章会话数，默认 5、允许 1，生效上限为 8；所有会话共享一个 Browser process/context/Profile。
默认两个决策 worker 推进不同平台，下载中的会话保留页面并让出 worker。`policy_overrides` 只接受
`rate_limit_group = "browser-generic"`；显式 `max_concurrency = 1` 保留全局串行语义，其他覆盖只能收紧已有访问政策。

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

| 情况                                    | 含义与处理                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 当前阶段正常未命中                      | 按五层顺序继续仍适用的下一阶段，最后独立判断 Browser 准入                                       |
| API 未配置或认证失败                    | 明确失败；不由 Browser 静默掩盖                                                                 |
| 公共 5xx、明确连接/请求失败或超时       | 保留故障，继续独立 API/Browser；后续均未取得 PDF 时返回原失败，不写自动耗尽                     |
| `429`、Retry-After、quota、API 临时错误 | 延期或失败，保持原准入边界；不写自动获取耗尽                                                    |
| Browser 尚在加载或换页                  | Network 等待稳定 Observation；不会让 Agent 操作半加载页面                                       |
| stale action                            | 不执行旧动作，返回新稳定 Observation                                                            |
| 登录/MFA/无权限/拒绝/未找到             | 作为 page state 交给 Agent；只有 Agent Stop 或硬故障后才形成对应稳定结果，不冒充 PDF miss       |
| 页面无语义变化、重复 challenge 动作     | 重复输入改为等待，保留硬预算；验证页上 Agent 停止形成 `browser-agent-stopped`，不写自动获取耗尽 |
| Candidate timeout                       | 仅等待实际进行中的捕获；空队列不掩盖原始停止原因，已接纳候选及时交付                            |
| 捕获到非 PDF 或损坏文件                 | Acquisition 拒绝并清理，不发布主资产                                                            |
| PDF 文章身份尚未验证                    | 有效文件正常入库并显示未验证标签，不阻断下载或解析                                              |
| runtime/cleanup failure                 | 系统失败并熔断 `browser-generic`，不写自动获取耗尽                                              |
| Ctrl+C                                  | 受控清理；重跑重新读取数据库 current facts                                                      |

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

### 失败诊断

Browser 限流保留 `pdf-browser-rate-limited`，报告提示等待平台 Retry-After 与共享冷却，
`retryable=true` 表示条件恢复后可重试，不代表立即重发。Agent 在阻塞页主动停止时，失败原因
带上观察到的 `page_state` 和 HTTP 状态；例如 `LOGIN_REQUIRED` 只说明这次页面要求登录，
不能推断机构一定没有版权。缺少已验证 runtime 时，报告给出 `SCIRETRIEVER_CLOAK_BUNDLE`
或 portable 包的恢复入口，不搜索临时目录或切换其它浏览器内核。
早期渠道的“不适用/没有能力”提示不会覆盖后续 Browser 的实际失败；例如 HTTP hint 转交
Browser 后用尽活跃预算，最终报告应显示 Browser 预算耗尽。早期来源的真正请求失败仍保留其原有诊断与选择规则。
