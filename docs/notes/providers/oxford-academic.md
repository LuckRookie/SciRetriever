# Oxford Academic

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；Oxford Academic 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://academic.oup.com`
- 当前仓库接入状态：`production-ready` Profile；无专属 Public 或授权 API route；Profile 只启用首页可达性 probe，真实文章统一使用 `browser:generic`

## 1. 官方入口与本轮证据边界

- [Oxford Academic](https://academic.oup.com/)：当前期刊与图书平台 origin。
- [Text and Data Mining](https://academic.oup.com/pages/open-research/text-and-data-mining)：官方 TDM 入口；本轮匿名请求返回 Cloudflare 403，正文未核实。
- [Standard legal terms and conditions](https://academic.oup.com/pages/standard-legal-terms-and-conditions)：官方法律条款入口；本轮匿名请求返回 403。
- [Open Access](https://academic.oup.com/pages/open-research/open-access)：官方 OA 入口；本轮匿名请求返回 403。
- [academic.oup.com robots.txt](https://academic.oup.com/robots.txt)：当前路径级 crawler policy。

本轮只核对上述官方引用及其作为访问条款/速率证据的边界；没有访问文章正文、跟随真实 DOI、
打开 PDF、登录机构账号、读取 Cookie/profile、调用真实 API、完成 Shibboleth/OpenAthens 或
绕过 Cloudflare。生产准入依赖版本化项目审慎政策和离线安全合同，不把旧经验、ScanSci 或相似
平台条款写成当前在线授权证据。

## 2. DOI、Public 与 API 结论

常见 DOI prefix `10.1093` 以及 `Oxford Academic` / `Oxford University Press` 文本只作弱
提示。Oxford Academic 承载大量不同 journal 路径和合作出版物；prefix、publisher 字符串或
Metadata Provider 来源不能单独证明 canonical landing、具体版本、文章 ID 或 entitlement。
实际 `academic.oup.com` landing 或可信来源明确给出的 asset origin 才是更强证据。

当前没有专属 Public route。可信 Metadata/OA 来源若明确提供安全 Oxford PDF 或 landing
`AssetHint`，通用第一层仍可逐项尝试，并继续经过实际字节、PDF reader、页面树、文章身份、
来源依据、许可证和不可变发布检查。Profile 不根据 DOI 或文章 path 合成 `/doi/pdf/`、
`/doi/epdf/` 或 `/article-pdf/` URL。

由于官方 TDM 页面当前无法匿名核实，本轮没有得到可实现的机器访问/PDF API endpoint、认证
方式、请求/响应 schema、内容版本、quota scope 或错误语义。授权 API capability 因而为
`unsupported`。将来若用户有 OUP 的书面 TDM/机构协议，需要先核对它交付的是 PDF、XML 还是
其它内容，并实现独立的 operator-managed adapter；不能把网页 URL 模板伪装成 API。

## 3. robots、Browser 与限速

当前 robots 对通用 user-agent 禁止多类内部、下载、citation、认证与搜索路径，包括：

```text
/DownloadFile/
/Citation/Download
/signin.aspx
/Shibboleth.sso/
/SignInShibboleth.aspx
/search-results
/advanced-search
```

它没有禁止所有文章或所有 `article-pdf` 路径，但“未被 robots 禁止”不等于任意批量授权；官方
也没有发布可直接采用的数值 Browser article-start interval。因此生产 Profile 使用项目审慎的
30 秒最小文章启动间隔、组内并发 1、rate-limit cooldown 和 runtime circuit，并继续遵守页面
返回的拒绝、challenge 与动态限流。

ScanSci 记录过 Oxford journal-specific article path、`/article-pdf/`、`/doi/pdf/`、
`/doi/epdf/`、Institutional Login/OpenAthens marker，以及一个 `pdf_response_captured` success。
该结果依赖上游项目的 Browser profile/Cookie 体系，且单个成功不能证明文章是否 OA、机构 entitlement、
长期 URL 合同或批量自动访问权。SciRetriever 不复制 Cookie、CARSI、selector、URL 改写或 verdict。

当前实现没有 Oxford 专属 Browser route、rule、selector 或调度组。可信 Oxford landing/asset
hint 或安全 DOI resolve 形成文章起点后统一进入 `browser:generic`；Agent 根据稳定页面观察选择
封闭动作，Network 负责页面稳定与 capture，Acquisition 再用目标 DOI、标题、作者、起点 lineage
和 PDF 字节排除 supplement、chapter/front matter 与 wrong-article。Profile 的
`browser_probe_enabled = true` 只允许配置中心打开 Oxford 首页检查 runtime/目标可达，不下载
正文或证明 entitlement。自动流程不导入或读取 Cookie，也不执行认证。

以下 Revision 3、`oxford-academic-pdf@*`、Oxford lane 和 Challenge 子生命周期描述均是
2026-08-21 至 2026-08-22 旧规则执行器的历史证据；它们不是当前 runtime 合同，不能证明
`browser:generic` 的成功率。

Revision 3 的新增证据日期为 2026-08-21，只为 Oxford Academic 规则声明受限的 Cloudflare
dependency：精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。
它不加入 Oxford 的普通 `allowed_origins`；只有当前 Oxford Publisher 页面或其 frame ancestry
能给出发起与用途证明时才可加载，不能作为初始/任意顶层导航、popup、PDF locator 或 capture
source。这里记录的 `resource-blocked`、`settling`、`cleared`、`interaction-required` 与
`settle-timeout` 是 2026-08-21 旧 Challenge 子生命周期的历史 fixture 词汇，不是当前运行合同。
旧执行器只执行当时已审查的动作，并在 controller 停止时形成文章级
`challenge-unresolved`。这些 fixture 只证明旧程序没有自行挡住必要资源，不证明当前 IP、机构
合同、文章 entitlement 或当前通用 Agent 的行为。

2026-08-22 的固定单篇真实串行 A/B 中，stock 与 Cloak 各自加载 17 个上述受限资源，本地阻断
均为 0，随后都在有界窗口形成 `settle-timeout`，没有捕获 PDF。这个结果证明当前文章绑定、
Turnstile 路径和 image 子资源没有再被 SciRetriever 自己误拦；它不证明自动验证已通过、文章有
权限或 Cloak 提高了下载成功率，也没有触发 CAPTCHA 点击。

CBA72 将 Oxford Academic 的本次服务器现场准入记为 `deferred`。这不降低其
`production-ready` Profile 状态，也不等于其它机构/Profile 全局 unsupported；它只表示固定
代表样本在旧执行器中停在持续自动验证且没有可验证 PDF。

Profile 的 `production-ready` 表示访问画像、证据 fixture 与首页 probe 合同闭环；不表示
Oxford 拥有专属 Browser 下载实现，也不表示当前 IP、机构协议或任意文章 entitlement 已经在线
证明。官方未发布数值 pacing 和 live entitlement 未核实仍作为 evidence gap 保留。

## 4. 共享平台不等于共享风险域

Oxford Academic 与 AIP Publishing 的 robots 路径、登录/下载端点名称和页面技术形状高度相似，
可作为共享发布平台模板的技术线索；现有证据不足以把 Atypon、Silverchair 或其它 vendor 名称
写成稳定业务合同。模板相似也不能证明两个出版社共享：

- 用户账号、机构 entitlement 或 Shibboleth session；
- Cookie domain、credential origin 或登录跳转 allowlist；
- WAF/account-warning、quota 或 Browser article pacing；
- primary/supplement 归属、产品许可或现场运营策略。

所以两个 Profile 使用独立 `platform_key` 与 origin，并分别保留外部政策证据；它们都不拥有
Browser group 或页面程序。未来证据变化也必须分别评估，不能仅按底层技术名称跨 origin 携带
credential 或推导 entitlement。

## 5. 资产归属与当前实现

可信 locator 得到的 PDF 必须证明是目标文章正文。Supplementary material/file 不能成为
`primary-pdf`；chapter、book front matter、metadata/loading 页面或 wrong article 必须排除。
路径中出现 `article-pdf` 或 DOI suffix 只是一项 locator 线索，不替代实际字节、页面树和文章
身份验证。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 Profile fixture
为 `tests/fixtures/acquisition/profiles/oxford-academic.json`。Fixture 证明弱/强 DOI 边界、无
专属 API route、首页 probe 与上游 Browser success 非授权证据；不再保存页面规则、调度组或
文章下载准入，测试 Profile 也不保存真实 DOI、正文、Cookie、账号、机构或 Browser Profile
内容。

Profile 已进入 production catalog，但只为访问画像解析和首页 probe 提供事实。真实文章只有在
Public/API 正常结束、强起点证据成立、Browser 显式启用且 runtime 就绪时进入
`browser:generic`。它不新增 Oxford credential section；无权限或未命中时仍可由用户独立手动
接纳 PDF。
