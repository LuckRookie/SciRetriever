# Publisher Access Profile 准入与验证矩阵

- 最后核对：2026-08-20
- 当前 schema：profile evidence fixture v1
- 文档性质：Publisher/Access Provider 易变事实、当前实现和验证缺口矩阵

本文记录 `PublisherAccessProfile` 的统一证据包、三态准入和当前仓库矩阵。它不重新定义 [ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md) 的三层顺序，也不表示拥有 Profile 就需要 Metadata Provider、API key 或 Browser session。新增或修改 Profile 还必须遵循 [Provider 接入开发手册](../../development/provider-integration.md)。

## 1. 三态只描述验证资格

每个已经进入验证矩阵的 Profile 恰有一个状态：

| 状态 | 含义 | 能否进入 production profile catalog |
| --- | --- | --- |
| `production-ready` | 当前声明的 route 已有官方/审慎政策、完整证据、生产对象图和离线验收；若声明 Browser，还必须有实际 `BrowserSiteRule` 和明确生产准入结论 | 可以；Browser route 只有在总开关、runtime 与调度准入满足后才执行逐文章检查 |
| `fixture-verified` | schema、安全、限速、页面状态和归属规则已由离线 fixture 证明，但官方使用政策或其它生产门槛仍阻止自动执行 | 不可以 |
| `unsupported` | 已审查但不能满足当前安全、政策、归属或可执行门槛；不声明任何可执行 route | 不可以 |

访问路径不是第四种状态。一个只支持公开或授权 API 的 Profile 可以是 `production-ready`，同时没有 Browser route；`public-api-only` 不再作为验证状态。Capability 列可以把已审查但未满足门槛的 Browser 路径记为 `unsupported`，这表示该 route 不存在，不会把整个已有 API Profile 降成第二个 Profile。尚未完成 P55 证据包的访问方不进入矩阵，不能为了表格覆盖把“未审查”写成 `unsupported`。

`production-ready` 也不表示当前 IP、机构或文章能够下载。凭据字段存在、Provider 接受凭据、
当前运行环境可启动 Browser、组织授权和具体 Literature entitlement 始终是不同事实。普通配置只用
`browser_enabled` 显式启用整个受控 Browser 第三层，不保存逐 Publisher 的“机器访问许可”占位
字段。该开关允许 production rule 做慢速逐文章机构 IP 尝试，但不能证明或扩大组织合同与文章
权限；实际页面必须区分正文、付费墙、裸 403、challenge、限流和无正文。

这里的 `PublisherAccessProfile` 是 route、origin、正文归属和 Provider policy 的证据对象；配置
中的 Browser Profile 则是本机身份与 Chrome 认证状态边界，两者不是同一个“Profile”概念。所有
production Browser route 共用普通配置选中的一个 operator-managed 持久 Browser Profile、一个
Chrome process 和一个 persistent BrowserContext；固定 `headless = false`，无 GUI Linux 使用
Xvfb，Publisher 请求由 Chrome 原生网络栈完成。自动流程不填写凭据或处理 challenge；配置中心可
通过独立显式动作打开同一 Profile 的可见 Browser，让用户自行处理其获授权的认证。跨 Publisher
本机 cap 默认 `5`，只接受大于 `1` 的整数且不设上限；本表当前 `9` 条 production route 不是配置
最大值，同一 risk group 始终保持并发 `1`。

## 2. 每个 Profile 的统一证据包

生产 `PublisherAccessEvidence` 与仓库内 `tests/fixtures/acquisition/profiles/<access-key>.json` 必须一一对应，至少覆盖：

1. 稳定 `access_key`、展示名、官方产品名和 Access Platform；
2. 当前官方资料、访问条款和限速/配额依据的静态 HTTPS 引用；
3. 核对日期、evidence revision、Provider Notes 和唯一 fixture reference；
4. landing/asset origins、稳定文章 ID namespace、Provider record identity 与脱敏样例；
5. public、authorized API、Browser 三种 capability 的实际 route key；
6. policy evidence/revision、API quota scope，或 Browser rate/session group；
7. Browser rule id/revision、login/entitlement/paywall/challenge marker；
8. primary、supplement、wrong-article 与 excluded 归属样例；
9. 当前缺口、未执行的现场验证和明确退役条件。

Evidence URL 不能含 userinfo、query、fragment、IP 地址或非 HTTPS scheme；Notes/fixture 必须是仓库内固定相对引用。Fixture 只保存合成 identity、locator 和状态，不保存真实正文、Cookie、token、账号、机构或 Browser profile。生产运行不读取测试 fixture；fixture reference 是源码、测试和维护证据之间的可审计连接。

## 3. Browser Profile 的额外准入门

Profile 不再保存一套与执行无关的 selector 摘要。它只引用 `browser_rule_id` 和正整数 revision；统一 `PublisherAccessVerificationMatrix` 必须把它与真正执行的 `BrowserSiteRule` 对齐：

- Profile 只有一个精确 landing origin，且与 rule 相同；
- Browser allowed origins 与 rule 完全相同；capture/supplement/excluded locator 的 origin 都属于 Profile asset origins；
- `browser_rate_limit_group` 与实际 web scope 相同，policy revision/group 对齐，`max_concurrency=1` 且至少有一种非零 pacing；
- identifier-in-path 只能使用 Profile 声明的稳定 namespace；
- 有明确 primary capture prefix 和 supplement 排除规则；
- entitlement/authenticated、login-required、paywall/not-entitled、challenge/MFA/rate/account-warning 四类状态各有至少一个封闭 marker；
- rule 必须被一个且仅一个 Profile 引用，缺失、游离、revision 漂移或不完整均在组装时失败。

Matrix 只把 `production-ready` Profile 和其 rule 派生到生产 catalog。`fixture-verified` rule 可以参加离线验收，但不能因为规则文件存在而被生产 Source 看见；`unsupported` Profile 不能声明 public、API 或 Browser executable route。未知站点没有 generic Browser fallback。

Operator 显式启用 Browser 后，production Profile 仍只能使用固定、受验证的 access key；未知
站点不会进入通用 fallback。总开关不会改写固定 origin、rule revision、正文归属、risk/session
group、限速、Network 安全或 challenge 停止条件，也不能替代组织授权与逐文章检查。

## 4. 当前矩阵

| Access key | Platform / product | Public | Authorized API | Browser | Policy / session group | Evidence | 状态 | 当前缺口 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `acm-digital-library` | ACM Digital Library Basic / Premium | ACM 论文自 2026-01-01 起 OA；无专属 executable route，明确 ACM PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；Premium bulk download 是产品功能，没有公开 API 合同 | `unsupported`；无 executable rule | DL policy 禁止 scripts/spiders 自动下载文章；robots 的 `Crawl-delay: 1` 不构成许可或 Browser policy；无 group/session | `acm-dl-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | Basic 有 PDF 和 basic TDM 但无 bulk download；缺官方自动获取协议、正文/related-artifact 归属和现场页面证据；不采信 ScanSci success verdict |
| `acs-publications` | ACS Publications article platform | 无专属 route；明确 ACS PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；ACS TDM 客户交付是 JATS/BITS XML，不是 PDF API | `browser:acs-publications` / `acs-publications-pdf@2`；总开关启用后逐文章机构 IP/Profile 检查 | 共享 persistent Profile/context 中的 `acs-publications` lane；同组串行；审慎最小启动间隔 30s | `acs-persistent-browser-pdf-v4-2026-08-21`；2026-08-19 | `production-ready` | 普通条款限制系统性/聚合下载；operator 须确认组织授权；离线规则与真实 Chromium 本地 HTTPS 验收不证明当前 IP、Profile 已登录或文章 entitlement |
| `aip-publishing` | AIP Publishing journals platform | 无专属 route；明确 OA PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未找到公开机器访问/PDF API 合同 | `browser:aip-publishing` / `aip-publishing-pdf@2`；总开关启用后逐文章机构 IP/Profile 检查 | 共享 persistent Profile/context 中的 `aip-publishing` lane；同组串行；审慎最小启动间隔 30s | `aip-persistent-browser-pdf-v4-2026-08-21`；2026-08-19 | `production-ready` | Terms 限制普通自动化访问；operator 须确认组织授权；Profile presence、登录状态和当前文章 entitlement 分开 |
| `american-mathematical-society` | American Mathematical Society journals platform | 无专属 route；明确 AMS Mathematics PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未找到可核实机器访问/PDF API | `unsupported`；无 executable rule | managed robots signal 仅明确 reference/search 用途，未发布数值 Browser 文章 policy；无 group/session | `ams-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/OA/subscriber 页面当前匿名 403；缺页面状态和正文/supplement 归属；American Meteorological Society 的 `10.1175`/ScanSci verdict 不属于本 Profile |
| `annual-reviews` | Annual Reviews journals platform | 无专属 route；明确 S2O/OA PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未找到可核实机器访问/PDF API | `unsupported`；无 executable rule | robots `Crawl-delay: 2` 只是 crawler policy，不是 Browser 许可或账号风险策略；无 group/session | `annual-reviews-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/S2O 页面当前匿名 403；缺页面状态和正文/supplement 归属；不复制特定高校 OpenAthens、SSO/2FA 或 CloakBrowser success |
| `aps-journals` | Physical Review journals platform | 无专属 route；可信 APS PDF/landing hint 仍由通用 Public Source 验证；`link.aps.org` 只作 redirect origin | `unsupported`；未找到可核实公共全文 API | `unsupported`；无 executable rule | robots 允许一般索引但只声明 `use=reference`，禁止 search/account/login；服务端 429/503 不是数值文章 policy；无 group/session | `aps-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/平台页当前匿名 403；缺自动 Browser 许可、初始 pacing、页面状态、正文/supplement/accepted-navigation 归属和现场 session 证据；不采信 ScanSci unsupported verdict 或特定高校失败 |
| `copernicus-publications` | Copernicus Publications OA journals | 无专属 route；精确 PDF/landing hint 仍由通用 Public Source 验证；动态 journal subdomain 不使用 wildcard | `unsupported`；OAI-PMH 提供 metadata/NLM XML，不是 PDF | `unsupported`；OA 内容不需要 Browser | robots 无数值 delay；首页仍展示高负载导致 journal PDF 临时受限的公告；无 Browser group/session | `copernicus-public-route-unregistered-2026-08-15`；2026-08-15 | `unsupported` | 缺稳定机器 PDF 合同和封闭 journal-host catalog；不采信上游 DOI URL 模板/Browser fallback；XML、preprint 与 supplement 不成为主 PDF |
| `core-open-access` | CORE API v3 | 通用已保存 locator 由独立 Public Source 消费；Profile 无专属 public route | `api:core` | 无 | `core/api` quota scope；无 Browser session | `core-v3-2026-08-15`；2026-08-15 | `production-ready` | Browser 未注册；不宣称真实 key 或单篇 entitlement |
| `elsevier-sciencedirect` | Elsevier Article Retrieval + Object Retrieval / ScienceDirect | 无专属 public route；已有 landing/direct hint 仍由通用 Public Source 消费 | `api:elsevier-article-object`；FULL XML 的显式 `MAIN web-pdf` attachment EID 优先取 Object PDF，无可用 MAIN object 时以同一强身份协商 Article PDF；可解析错误不绕过 | `browser:elsevier-sciencedirect` / `sciencedirect-pdf@2`；从强 DOI/PII、ScienceDirect 或 `linkinghub.elsevier.com` DOI 第一跳识别正文，批准 ScienceDirect 与 PDF CDN，排除 supplement/错文 | API 使用 `elsevier/api/article-retrieval-object` quota scope；Browser 使用共享 persistent Profile/context 中的 `elsevier` lane，同组串行，审慎最小启动间隔 20s | `elsevier-api-persistent-browser-pdf-v3-2026-08-21`；2026-08-19 | `production-ready` | 离线 fixture 与真实 Chromium 证明规则、动态 redirect、CDN capture 和安全边界；不证明真实 key、当前机构 IP、Profile 已登录、订阅或单篇 entitlement |
| `frontiers` | Frontiers journals platform | 无专属 route；明确 Frontiers PDF/landing hint 仍由通用 Public Source 验证；官方确认全部 article 立即、永久 CC BY OA | `unsupported`；未找到可核实机器 PDF API | `unsupported`；OA 内容不需要 Browser | robots 允许一般索引但没有数值下载 policy；无 group/session | `frontiers-public-route-unregistered-2026-08-15`；2026-08-15 | `unsupported` | 条款静态响应只有应用 shell；缺稳定 per-article PDF 合同和数值 policy；不采信上游 `/articles/{doi}/pdf` 模板或 Browser success |
| `ieee-xplore` | IEEE Xplore article / Full-Text Access platform | 无专属 route；明确 IEEE PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；官方 full-text 产品需销售开通的 authorization key/token，但公开 endpoint、媒体类型和 rate limit 不完整 | `unsupported`；无 executable rule | 注册后 API quota 未知；无 Browser group/session | `ieee-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 已声明强定位 `ieee-arnumber`，但不猜 DOI suffix；缺可实现 API 合同、页面状态、stamp PDF/supplement 归属和通用 session 证据；不复制特定高校 SSO/2FA 结果 |
| `iopscience` | IOPscience journals platform | 无专属 route；明确 OA PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；需事先联系，审查后通过 SFTP/约定方式交付 XML/PDF，不是公共 API | `browser:iopscience` / `iopscience-pdf@2`；总开关启用后逐文章机构 IP/Profile 检查 | 共享 persistent Profile/context 中的 `iopscience` lane；同组串行；审慎最小启动间隔 30s | `iopscience-persistent-browser-pdf-v4-2026-08-21`；2026-08-19 | `production-ready` | 普通 Terms/TDM/robots 有严格限制；operator 须确认组织授权；不复制特定高校 OpenAthens/2FA 数据或结论 |
| `mdpi` | MDPI journals platform | 无专属 route；明确 MDPI PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未核实机器 PDF API | `unsupported`；OA claim 不构成 Browser 必要性 | 首页、OA、条款与 robots 当前均为匿名 403；policy `unverified`；无 group/session | `mdpi-public-route-unregistered-2026-08-15`；2026-08-15 | `unsupported` | 缺可审查的官方 per-article PDF 合同、数值下载政策和归属规则；不采信上游 ISSN/DOI `/pdf` 模板或 Browser success |
| `nature-portfolio` | Nature.com article platform | 无专属 route；明确 Nature PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；Springer Nature JATS/XML 不是 PDF | `unsupported`；无 executable rule | 集团 TDM policy 提到内容平台 1 request/s，但未证明 Nature 的文章间隔、risk/session group | `nature-browser-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款与机构 TDM 权利需单独确认；缺登录/entitlement/challenge、正文/extended-data/supplement 归属及现场 session 证据；`10.1038` 仅弱提示 |
| `oxford-academic` | Oxford Academic journals platform | 无专属 route；明确 Oxford PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未核实独立机器访问/PDF API 合同 | `browser:oxford-academic` / `oxford-academic-pdf@2`；以强 DOI/Oxford landing 识别正文并排除 supplement/chapter/wrong-article | 共享 persistent Profile/context 中的 `oxford-academic` lane；同组串行；项目审慎最小启动间隔 30s | `oxford-persistent-browser-pdf-v3-2026-08-21`；2026-08-19 | `production-ready` | 官方条款、TDM、OA 与 robots 已纳入证据；准入只证明离线规则与安全边界，不采信 ScanSci verdict，也不证明当前 IP、Profile 已登录、机构协议或单篇 entitlement |
| `pnas` | PNAS journals platform | 无专属 route；明确 PNAS PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；允许 `showXml` 的 robots path 不构成全文 API | `unsupported`；无 executable rule；`/doi/epdf/` 被 robots 明确禁止 | 未发布数值 Browser 文章 policy；与 Science 的 CDN/path 相似不形成共享 group/session | `pnas-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/OA/平台页当前匿名 403；缺可执行 PDF action、页面状态、正文/supplement/reader 归属和现场 session 证据；不采信 ScanSci ePDF success verdict |
| `plos` | PLOS journals and public article access | 无专属 route；官方记录单篇 `type=printable` PDF，精确 hint 由通用 Public Source 验证；官方不鼓励批量 article PDF | `unsupported`；Solr search 与 JATS XML 不是 direct PDF API | `unsupported`；公开 PDF 不需要 Browser | `journals.plos.org` 使用共享 `plos/web` scope，`max_concurrency=1`、`min_start_interval=30s`；无 Browser session | `plos-public-pdf-bulk-discouraged-2026-08-15`；2026-08-15 | `unsupported` | 不从弱 DOI 猜 journal path，不采用 PLOS ONE 默认 fallback；需要时优先官方 corpus/XML；supporting information 与 XML/HTML 不成为主 PDF |
| `royal-society-publishing` | Royal Society Publishing journals platform | 无专属 route；明确 Royal Society PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未找到可核实机器访问/PDF API | `unsupported`；无 executable rule | 平台、条款、OA 与 robots 当前均无法匿名审查；无数值 pacing、group/session | `royal-society-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 缺官方自动访问政策、页面状态、正文/supplement 归属和现场 session 证据；共享 CDN/template 与 ScanSci success 不构成 risk/session 或生产证据 |
| `rsc-publishing` | Royal Society of Chemistry publishing platform | 无专属 route；明确 RSC PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未证明 direct PDF API | `browser:rsc-publishing` / `rsc-publishing-pdf@2`；总开关启用后逐文章机构 IP/Profile 检查 | 共享 persistent Profile/context 中的 `rsc-publishing` lane；同组串行；审慎最小启动间隔 30s | `rsc-persistent-browser-pdf-v4-2026-08-21`；2026-08-19 | `production-ready` | 普通条款限制自动化软件下载，TDM 项目要求预先联系；operator 须确认组织授权；规则覆盖正文/ESI/错文但不证明 Profile 已登录或当前 entitlement |
| `science-aaas` | Science journals platform | 无专属 route；明确 Science PDF/landing hint 仍由通用 Public Source 验证；robots 的 XML/supplement allowance 不生成主 PDF route | `unsupported`；未核实机器访问/PDF API 合同 | `browser:science-aaas` / `science-aaas-pdf@2`；以强 DOI/Science landing 识别正文并排除 supplement/media/wrong-article | 共享 persistent Profile/context 中的 `science-aaas` lane；同组串行；项目审慎最小启动间隔 30s | `science-persistent-browser-pdf-v3-2026-08-21`；2026-08-19 | `production-ready` | 条款、OA 与 robots 已纳入证据；与 PNAS 的 CDN/path 相似不形成共享组，不采信 ScanSci verdict，也不证明当前 IP、Profile 已登录或单篇 entitlement |
| `springerlink` | Springer Nature Link article platform | 无专属 route；metadata PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；OA/Full Text 只提供 JATS/XML，不是 PDF API | `browser:springerlink`；`springerlink-pdf@5` 从唯一 DOI 构造经审查的官方 PDF locator，等待 response/download/popup/viewer 任一正文 capture；Provider opaque asset path 不被导航；精确允许 Link、static-content、IDP 与 WAYF origin | 共享 persistent Profile/context 中的 `springerlink` lane；同组串行；每篇文章启动间隔至少 10s；使用运行机器正常网络出口 | `springerlink-persistent-browser-pdf-v6-2026-08-21`；2026-08-18 | `production-ready` | 本地 HTTPS + 真实 Chromium 已验证 PDF response/native download、延迟事件生命周期、lane reuse、取消/超时和清理；历史小样本不证明当前 IP、Profile 已登录或任意文章 entitlement，`10.1007` 仍只是弱提示 |
| `wiley-online-library` | Wiley Online Library TDM API v1 / article platform | 无专属 public route；已有公开 hint 仍由通用 Public Source 消费 | `api:wiley-tdm-v1` | `browser:wiley-online-library` / `wiley-online-library-pdf@2`；以强 DOI/Wiley landing 或 `advanced.onlinelibrary.wiley.com` 第一跳识别正文并排除 supplement/错文 | API 使用 `wiley/api` quota scope；Browser 使用共享 persistent Profile/context 中的 `wiley` lane，同组串行，审慎最小启动间隔 20s | `wiley-api-persistent-browser-pdf-v3-2026-08-21`；2026-08-19 | `production-ready` | API 与 Browser 的离线合同分别闭环；不把 ScanSci/CARSI 历史运行或一次 API 探测扩展为当前 IP、Profile 已登录、机构协议或长期 entitlement |
| `world-scientific` | World Scientific journals platform | 无专属 route；明确 World Scientific PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；robots 允许 `showXml` 不构成主 PDF API | `unsupported`；无 executable rule | robots `Crawl-delay: 1` 只是 crawler policy，不是 Browser 许可或账号风险策略；无 group/session | `world-scientific-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款当前匿名 403；缺页面状态和正文/supplement/reader 归属；不复制机构链、Terms 点击、持久认证或 viewer-capture success |

2026-08-16 经用户明确授权的 SpringerLink 首页 probe 只证明当时的正式 Chromium 可以启动并
到达 Link/IDP；首页无法判断机构 IP。2026-08-18 后续四个脱敏文章样本均形成非超时终态：三个
normal miss，一个通过当时机构网段交付 primary PDF；同进程双样本还证明 operation-local session
可复用。当前 probe 合同不再观察或报告个人登录，只报告 runtime/目标可达，并固定
`article_entitlement=not-proven`。历史结果没有被扩写成 Nature、其它 Springer Nature 平台、
当前 IP、任意 DOI 的 entitlement 或长期下载成功率。

因此当前验证矩阵有 23 项，production profile catalog 有 10 项，production Browser rule catalog 有 9 项。CORE、Elsevier 与 Wiley 实现授权 API route；ACS Publications、AIP Publishing、Elsevier / ScienceDirect、IOPscience、Oxford
Academic、RSC Publishing、Science / AAAS、Springer Nature Link 与 Wiley Online Library 实现 Browser route。
9 条 Browser route 在本地均通过 production 工程准入；Browser 总开关和 runtime 就绪后才会
成为可执行 route，并在真实页面逐文章判断结果。其余已审查 Profile 保留各自有证据的
`unsupported` 结论。相似平台、共享 CDN、上游成功记录、
OA 属性、crawler delay、XML 交付或人工单篇访问都不会自动形成 route、共享 risk/session group
或生产授权。后续访问方只有在各自 Notes、manifest、rule/fixture 和状态结论闭环后才加入本表。

## 5. 离线验收边界

当前统一合同测试会：

- 逐项核对验证矩阵中的每个 Profile 与 evidence manifest 的名称、日期、revision、官方引用、origin、identity 和 capability；
- 证明缺失、游离、重复引用、revision 漂移、origin/risk scope 不一致或缺少页面/补充材料规则时 fail closed；
- 用本地 Browser gate fixture 实际分类 primary、supplement、wrong-article 和 excluded capture；
- 证明 `fixture-verified`/`unsupported` 不进入 production 派生 catalog，并证明总开关关闭或 runtime 未就绪时不会构造可执行 Browser adapter。

这些测试不连接真实 Provider，也不读取真实用户 Browser Profile、Cookie、凭据或登录状态；测试
Profile 只创建在系统临时目录中。它们不证明站点长期稳定、用户权限或下载成功率。真实只读核实
只能按[受控 Browser 现场核实门](browser-live-verification/README.md)为一个明确 access key 建立
核实单并取得用户另行授权；probe 使用普通配置选中的持久 Profile 和当前机器正常网络出口，但不
隐式执行登录或检查认证。若用户需要设置认证，必须在配置中心通过独立显式动作打开同一 Profile
的可见 Browser。结果必须脱敏并单独更新对应 Provider Notes、evidence revision 和状态。
