# Publisher Access Profile 准入与验证矩阵

- 最后核对：2026-08-15
- 当前 schema：profile evidence fixture v1
- 文档性质：Publisher/Access Provider 易变事实、当前实现和验证缺口矩阵

本文记录 `PublisherAccessProfile` 的统一证据包、三态准入和当前仓库矩阵。它不重新定义 [ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md) 的三层顺序，也不表示拥有 Profile 就需要 Metadata Provider、API key 或 Browser session。新增或修改 Profile 还必须遵循 [Provider 接入开发手册](../../development/provider-integration.md)。

## 1. 三态只描述验证资格

每个已经进入验证矩阵的 Profile 恰有一个状态：

| 状态 | 含义 | 能否进入 production profile catalog |
| --- | --- | --- |
| `production-ready` | 当前声明的 route 已有官方/审慎政策、完整证据、生产对象图和离线验收；若声明 Browser，还必须有实际 `BrowserSiteRule` 和必要授权验证 | 可以，只装配该 Profile 明确声明的 route |
| `fixture-verified` | schema、安全、限速、页面状态和归属规则已由离线 fixture 证明，但仍缺真实平台、session、entitlement 或其它生产证据 | 不可以 |
| `unsupported` | 已审查但不能满足当前安全、政策、归属或可执行门槛；不声明任何可执行 route | 不可以 |

访问路径不是第四种状态。一个只支持公开或授权 API 的 Profile 可以是 `production-ready`，同时没有 Browser route；`public-api-only` 不再作为验证状态。Capability 列可以把已审查但未满足门槛的 Browser 路径记为 `unsupported`，这表示该 route 不存在，不会把整个已有 API Profile 降成第二个 Profile。尚未完成 P55 证据包的访问方不进入矩阵，不能为了表格覆盖把“未审查”写成 `unsupported`。

`production-ready` 也不表示所有账号或文章都能下载。凭据字段存在、Provider 接受凭据、当前运行环境有授权和具体 Literature 有 entitlement 始终是不同事实。

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

Evidence URL 不能含 userinfo、query、fragment、IP 地址或非 HTTPS scheme；Notes/fixture 必须是仓库内固定相对引用。Fixture 只保存合成 identity、locator 和状态，不保存真实正文、Cookie、token、账号、机构或个人 Browser profile。生产运行不读取测试 fixture；fixture reference 是源码、测试和维护证据之间的可审计连接。

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

## 4. 当前矩阵

| Access key | Platform / product | Public | Authorized API | Browser | Policy / session group | Evidence | 状态 | 当前缺口 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `acm-digital-library` | ACM Digital Library Basic / Premium | ACM 论文自 2026-01-01 起 OA；无专属 executable route，明确 ACM PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；Premium bulk download 是产品功能，没有公开 API 合同 | `unsupported`；无 executable rule | DL policy 禁止 scripts/spiders 自动下载文章；robots 的 `Crawl-delay: 1` 不构成许可或 Browser policy；无 group/session | `acm-dl-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | Basic 有 PDF 和 basic TDM 但无 bulk download；缺官方自动获取协议、正文/related-artifact 归属和现场页面证据；不采信 ScanSci success verdict |
| `acs-publications` | ACS Publications article platform | 无专属 route；明确 ACS PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；ACS TDM 客户交付是 JATS/BITS XML，不是 PDF API | `unsupported`；无 executable rule | 许可条款允许限制有不利影响的自动化工具，未发布可执行 Browser 文章速率；无 group/session | `acs-browser-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款禁止默认系统性/聚合下载；匿名政策页触发 challenge；缺登录/entitlement/challenge、正文/Supporting Information 归属和现场 session 证据；不采信 ScanSci success verdict |
| `aip-publishing` | AIP Publishing journals platform | 无专属 route；明确 OA PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未找到公开机器访问/PDF API 合同 | `unsupported`；无 executable rule | Terms 明确禁止 automated program/tool/process 访问站点或收集内容；robots 禁止下载和认证等路径；无 group/session | `aip-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 机构许可允许人工单篇下载但不授权自动化；缺数值 Browser pacing、页面状态、正文/supplement 归属和现场 session 证据；不因 Atypon/Silverchair 技术线索或 ScanSci success 建立共享组 |
| `aps-journals` | Physical Review journals platform | 无专属 route；可信 APS PDF/landing hint 仍由通用 Public Source 验证；`link.aps.org` 只作 redirect origin | `unsupported`；未找到可核实公共全文 API | `unsupported`；无 executable rule | robots 允许一般索引但只声明 `use=reference`，禁止 search/account/login；服务端 429/503 不是数值文章 policy；无 group/session | `aps-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/平台页当前匿名 403；缺自动 Browser 许可、初始 pacing、页面状态、正文/supplement/accepted-navigation 归属和现场 session 证据；不采信 ScanSci unsupported verdict 或特定高校失败 |
| `core-open-access` | CORE API v3 | 通用已保存 locator 由独立 Public Source 消费；Profile 无专属 public route | `api:core` | 无 | `core/api` quota scope；无 Browser session | `core-v3-2026-08-15`；2026-08-15 | `production-ready` | Browser 未注册；不宣称真实 key 或单篇 entitlement |
| `elsevier-sciencedirect` | Elsevier Article Retrieval + Object Retrieval / ScienceDirect | 无专属 public route；已有 landing/direct hint 仍由通用 Public Source 消费 | `api:elsevier-article-object`；FULL XML 的显式 `MAIN web-pdf` attachment EID 再取 Object PDF | `unsupported`；无 executable rule | `elsevier/api/article-retrieval-object` quota scope；Browser group/session 未猜测 | `elsevier-article-object-2026-08-15`；2026-08-15 | API Profile `production-ready` | ScienceDirect Browser 缺独立 selector、状态 marker、速率/session 与正文归属证据；ScanSci challenge 记录不作为成功；不宣称真实 key、机构订阅或单篇 entitlement |
| `ieee-xplore` | IEEE Xplore article / Full-Text Access platform | 无专属 route；明确 IEEE PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；官方 full-text 产品需销售开通的 authorization key/token，但公开 endpoint、媒体类型和 rate limit 不完整 | `unsupported`；无 executable rule | 注册后 API quota 未知；无 Browser group/session | `ieee-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 已声明强定位 `ieee-arnumber`，但不猜 DOI suffix；缺可实现 API 合同、页面状态、stamp PDF/supplement 归属和通用 session 证据；不复制特定高校 SSO/2FA 结果 |
| `iopscience` | IOPscience journals platform | 无专属 route；明确 OA PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；需事先联系，审查后通过 SFTP/约定方式交付 XML/PDF，不是公共 API | `unsupported`；无 executable rule | Terms 禁止系统下载，TDM policy 禁止未授权自动工具，通用 robots 全站禁止；无 group/session | `iopscience-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 缺书面机器访问协议、公开 endpoint/quota、页面状态、正文/supplement 归属和现场 session 证据；不复制特定高校 OpenAthens/2FA |
| `nature-portfolio` | Nature.com article platform | 无专属 route；明确 Nature PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；Springer Nature JATS/XML 不是 PDF | `unsupported`；无 executable rule | 集团 TDM policy 提到内容平台 1 request/s，但未证明 Nature 的文章间隔、risk/session group | `nature-browser-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款与机构 TDM 权利需单独确认；缺登录/entitlement/challenge、正文/extended-data/supplement 归属及现场 session 证据；`10.1038` 仅弱提示 |
| `oxford-academic` | Oxford Academic journals platform | 无专属 route；明确 Oxford PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；TDM 页面当前匿名 403，未核实机器访问/PDF API 合同 | `unsupported`；无 executable rule | robots 禁止多类 download/citation/auth/search 路径但没有数值文章 policy；与 AIP 的平台模板相似不形成共享 group/session | `oxford-academic-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款、TDM、OA 和平台页当前匿名 403；缺自动 Browser 许可、pacing、页面状态、正文/supplement/chapter 归属和现场 session 证据；不采信 ScanSci success verdict |
| `pnas` | PNAS journals platform | 无专属 route；明确 PNAS PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；允许 `showXml` 的 robots path 不构成全文 API | `unsupported`；无 executable rule；`/doi/epdf/` 被 robots 明确禁止 | 未发布数值 Browser 文章 policy；与 Science 的 CDN/path 相似不形成共享 group/session | `pnas-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/OA/平台页当前匿名 403；缺可执行 PDF action、页面状态、正文/supplement/reader 归属和现场 session 证据；不采信 ScanSci ePDF success verdict |
| `rsc-publishing` | Royal Society of Chemistry publishing platform | 无专属 route；明确 RSC PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；未证明 direct PDF API | `unsupported`；无 executable rule | 官方条款禁止自动化软件下载，TDM 项目要求预先联系；无 Browser group/session | `rsc-browser-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 缺明确机器访问许可/数值政策、页面状态、正文/ESI/wrong-article 归属和现场 session 证据；不采信 ScanSci `rsc_articlepdf` success verdict |
| `science-aaas` | Science journals platform | 无专属 route；明确 Science PDF/landing hint 仍由通用 Public Source 验证；robots 的 XML/supplement allowance 不生成主 PDF route | `unsupported`；未核实机器访问/PDF API 合同 | `unsupported`；无 executable rule | 未发布数值 Browser 文章 policy；与 PNAS 的 CDN/path 相似不形成共享 group/session | `science-aaas-automated-access-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 条款/OA/平台页当前不可匿名读取；缺自动 Browser 许可、页面状态、正文/supplement/media 归属和现场 session 证据；不采信 ScanSci success verdict |
| `springerlink` | Springer Nature Link article platform | 无专属 route；metadata PDF/landing hint 仍由通用 Public Source 验证 | `unsupported`；OA/Full Text 只提供 JATS/XML | `unsupported`；无 executable rule | 集团 TDM policy 提到内容平台 1 request/s，但 Link 通用条款禁止系统下载/crawling；未建立 group/session | `springerlink-browser-unsupported-2026-08-15`；2026-08-15 | `unsupported` | 缺机构协议适用性、页面状态、正文/supplement 归属及现场 session 证据；不把 `10.1007`、`springer` metadata 来源或 ScanSci URL 模板当强证据 |
| `wiley-online-library` | Wiley Online Library TDM API v1 | 无专属 public route | `api:wiley-tdm-v1` | `unsupported`；无 executable rule | `wiley/api` quota scope；Browser group/session 未猜测 | `wiley-tdm-v1-client-1.2.0-2026-08-15`；2026-08-15 | API Profile `production-ready` | 缺独立页面规则、Browser 速率、状态 marker、正文/supplement fixture；不把 ScanSci/CARSI 历史运行或一次 API 探测扩展为 Browser/长期 entitlement |

因此当前验证矩阵有 15 项，production profile catalog 有 3 项，production Browser rule catalog 有 0 项。这个结果只说明 CORE、Elsevier 与 Wiley 已实现 API route 的准入；ACM、ACS、AIP、APS、Oxford、PNAS、Science、RSC、IEEE、IOP、Wiley、ScienceDirect、SpringerLink 与 Nature Browser 均已有明确的 unsupported 结论，不把“没有上线”伪装成成功或尚未审查。ACM 的内容开放与自动路线准入保持分离，IOP 的书面约定交付也不冒充公共 API；AIP 的人工机构访问不被扩张成自动 Browser 权利，Oxford 与 AIP 的相似平台模板也不自动共享 risk/session group；APS 的 redirect origin 和索引 policy 不被改写为 PDF 自动路线；Science 的 supplement/XML allowance 与 PNAS 的 ePDF 禁止分别处理，二者不因共享 CDN/path 合并；SpringerLink 与 Nature 保持两个 Profile，集团政策引用相同不会自动共享 rate/session group。后续访问方只有在各自 Notes、manifest、rule/fixture 和状态结论闭环后才加入本表。

## 5. 离线验收边界

当前统一合同测试会：

- 逐项核对验证矩阵中的每个 Profile 与 evidence manifest 的名称、日期、revision、官方引用、origin、identity 和 capability；
- 证明缺失、游离、重复引用、revision 漂移、origin/risk scope 不一致或缺少页面/补充材料规则时 fail closed；
- 用本地 Browser gate fixture 实际分类 primary、supplement、wrong-article 和 excluded capture；
- 证明 `fixture-verified`/`unsupported` 不进入 production 派生 catalog。

这些测试不连接真实 Provider、机构登录或 Browser profile，也不证明站点长期稳定、用户权限或下载成功率。真实只读核实只能由用户明确授权，结果必须脱敏并单独更新对应 Provider Notes、evidence revision 和状态。
