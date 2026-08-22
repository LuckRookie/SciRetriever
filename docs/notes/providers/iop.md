# IOPscience

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；IOPscience 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://iopscience.iop.org`
- 当前仓库接入状态：`production-ready`；Browser rule 已进入生产 catalog，总开关启用且 runtime 就绪后逐文章检查机构 IP 访问；无专属 Public 或授权 API route

## 1. 官方入口与证据

- [Text and Data Mining Policy](https://ioppublishing.org/legal/textanddataminingpolicy/)：2026-07 版机器访问、内容交付和使用边界。
- [IOP Terms and Conditions](https://ioppublishing.org/terms-conditions/)：网站使用与系统性下载限制。
- [Licencing](https://ioppublishing.org/librarians/licencing/)：机构订阅与 site licence 入口。
- [OpenAthens and SeamlessAccess](https://ioppublishing.org/news/iop-publishing-collaborates-with-openathens-and-seamlessaccess-to-improve-user-experience/)：官方机构 federated sign-on 说明。
- [IOPscience robots.txt](https://iopscience.iop.org/robots.txt)：当前 crawler policy；通用 user-agent 为 `Disallow: /`。

上述材料均为 IOP Publishing 官方资料。2026-07 TDM policy 通过 IOP 官方 WordPress REST 内容核对；本轮没有联系 content support、签署协议、访问论文、登录机构账号、完成 SSO/MFA、下载全文或绕过 IOPscience 的 PerfDrive challenge。

## 2. 官方 TDM 不是网页批量下载 API

IOP 的 2026-07 policy 明确承认 metadata、full text 和 supplementary data 的研究价值，同时说明 IOPscience 会通过多种方式阻断 systematic downloading。需要大量数据做 AI/TDM 的研究者必须先联系 `contentsupport@ioppublishing.org`，提交身份、机构、DOI/日期范围、所需 XML/PDF、时长和用途；IOP 审查后可能通过 SFTP 或其它约定方式交付，并可能对 full-text XML/PDF 收取费用。

对 subscription content，研究者或所属机构必须拥有覆盖目标内容的有效订阅；商业用途需要另行书面同意。Gold OA 文章的使用权由具体 Creative Commons licence 决定，但 policy 仍要求为避免触发系统性下载保护而先联系 IOP。政策还明确指出：普通内容访问不自动带来 API、machine-readable feed、XML delivery、MCP、software agent 或其它 machine-to-machine 权利；这些能力需要单独书面协议，也可能有额外费用与 authentication/rate-limit 条款。

因此当前仓库不能把“IOP 可以按约交付 PDF/XML”翻译成普通 API credential：

- 没有公开 endpoint、请求/响应 schema、SFTP 目录合同或 quota scope；
- 每个使用方的内容范围、格式、保留期和用途由单独审查决定；
- 获得 metadata-only XML 不能形成 `TemporaryPdf`；
- 将来若用户取得书面协议，应实现独立的 operator-managed delivery adapter，而不是复用网页 Browser。

## 3. DOI、公开文章与补充材料

常见 DOI prefix `10.1088` 和 `IOP Publishing` / `Institute of Physics Publishing` / `IOPscience` 文本只作弱提示，不能单独证明当前 Literature 的原文访问方或 entitlement。实际 IOPscience landing、可信来源明确给出的 asset origin，或未来约定交付清单中的 DOI 才是更强证据。

ScanSci 记录过以下形状：

```text
landing: /article/{doi}
PDF:     /article/{doi}/pdf
```

它也记录过 PerfDrive challenge，以及经特定高校 OpenAthens/SSO/2FA 后捕获 PDF 的结果。SciRetriever 不复制机构 Cookie、CARSI 身份、CloakBrowser 或 success verdict，也不把 URL 形状当成官方稳定合同。

IOP policy 明确把 full text 与 supplementary data 分开。即使约定交付或可信公开 hint 得到 PDF，仍需证明它是目标文章正文；supplementary data/file 不能成为 `primary-pdf`，metadata/abstract/reference-only XML 也必须排除。

## 4. Browser 与限速结论

机构订阅、IP access、OpenAthens 和 SeamlessAccess 证明用户可能读取有 entitlement 的内容，
但不能由本地配置预先证明具体文章权限。当前政策风险仍必须保留：

- 通用 Terms 明确写明 systematic downloading of files is prohibited；
- TDM policy 要求先联系并走 SFTP/约定交付，且禁止未经明确授权的 automated search/scrape/deep-link/index；
- 当前 `robots.txt` 对通用 user-agent 全站禁止，未给出可执行数值 Browser 文章间隔；
- 匿名 IOPscience 请求在当前环境进入 PerfDrive CAPTCHA，本轮没有绕过；
- ScanSci 的特定高校成功不能推广到其它用户或长期平台合同。

仓库已经建立技术规则 `iopscience-pdf@2`，用合成 fixture 验证 IOPscience 精确 origin、强 DOI
归属、primary/supplement/wrong-article 分类、封闭页面状态，以及独立 `iopscience` risk/session
group、组内并发 1 和 30 秒审慎基线。规则与生产对象图已达到工程准入要求并进入 production
catalog；operator 显式启用受控 Browser 后，route 才能执行逐文章机构 IP 尝试。该总开关不能
证明组织授权或文章 entitlement，operator 仍须确认使用符合 IOP 条款。IOP 不会因与 AIP/APS
同属物理出版领域而共享风险组；约定 SFTP/XML/PDF 交付协议也不会被冒充成 Browser 成功证据。

## 5. 当前实现边界

secret-free production Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，技术
规则位于 `src/sciretriever/acquisition/sources/browser_rules/providers/iop.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/iopscience.json`。Fixture 证明弱/强 DOI 证据边界、约定交付
与公共 API 的分离、正文/supplement 归属和页面状态；不保存真实
DOI、正文、Cookie、账号、机构或通信内容。

现有 Metadata/OA 来源若明确提供安全 IOP PDF/landing `AssetHint`，仍可由通用第一层在用户授权
边界内尝试，并接受实际字节、PDF reader、页面树、来源依据和不可变发布检查。Browser 总开关
关闭时 Profile 不构造可执行 Browser adapter；启用后也只使用审核过的 `/article/{doi}/pdf`
流程、固定调度和逐文章检查，不联系其它 IOP 服务、不新增 credential section，也不证明当前
文章 entitlement。
本轮没有执行真实 IOP 文章 probe 或正文下载。

## 6. 2026-08-22 Cloak 切换门现场证据

固定单篇、stock/Cloak 交替且同 Publisher 启动间隔至少 30 秒的真实 A/B 中，两套引擎都没有
取得 PDF：stock 形成 `no-download`；Cloak 观察到 IOP 顶层流程三次转向
`validate.perfdrive.com` 后，因该 origin 不属于已审核 IOP 规则而 fail closed 为 `policy`。
定向诊断只保留 hostname、导航形状和有界结果，没有记录完整 URL、path/query、页面正文、
Cookie、Profile 或 challenge token；它确认该结果不是 cleanup/runtime 故障，Cloak 共享
process/context 仍可被后续 Publisher 复用。

这次结果不能复现 2026-08-21 的 IOP 成功样本，也不能据此宣称是 CloakBrowser 提高或降低了
文章 entitlement：同轮 stock 同样没有交付，差异只是 Cloak 对未审核顶层 challenge 导航明确
拒绝。SciRetriever 不把 PerfDrive origin 临时加入普通 `allowed_origins`，不自动点击或破解
CAPTCHA，也不以放宽 top-frame/文章绑定换取成功。CBA72 的本次服务器现场准入已将 IOP 记为
`deferred`，直到有独立的、受限 PerfDrive 生命周期合同或新的无 challenge 成功证据；这不删除
`production-ready` 工程 rule，也不等于其它机构/Profile 全局 unsupported。离线
IOP PDF response/download fixture 继续证明已审核成功链没有被删除。
