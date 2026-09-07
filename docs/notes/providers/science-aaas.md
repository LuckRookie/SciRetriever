# Science / AAAS

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；Science/AAAS 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.science.org`
- 当前仓库接入状态：`production-ready` Profile；无专属 Public 或授权 API route；Profile 只启用首页可达性 probe，真实文章统一使用 `browser:generic`

## 1. 官方入口与本轮证据边界

- [Science journals platform](https://www.science.org/)：当前文章平台 origin。
- [AAAS terms](https://www.aaas.org/terms)：AAAS 通用条款入口；本轮只返回需要 JavaScript 的外壳，正文未核实。
- [Science terms of use](https://www.science.org/content/page/terms-use)：Science 条款入口；本轮匿名请求返回 Cloudflare 403。
- [Science open access](https://www.science.org/content/page/open-access-aaas)：OA 入口；本轮匿名请求返回 403。
- [science.org robots.txt](https://www.science.org/robots.txt)：当前 crawler 路径与 agent policy。

本轮只核对上述官方引用及其作为访问条款/速率证据的边界；没有访问文章正文、跟随真实 DOI、
打开 PDF、登录机构账号、读取 Cookie/profile、调用真实 API、完成 SSO 或绕过 Cloudflare。
生产准入依赖版本化项目审慎政策和离线安全合同，不把旧经验、ScanSci 或其它 Atypon 类站点写成
当前在线授权证据。

## 2. DOI、Public 与 robots capability

常见 DOI prefix `10.1126` 以及 `AAAS` / `American Association for the Advancement of
Science` / `Science Journals` 文本只作弱提示，不能独立证明 canonical landing、具体刊物、
文章版本或 entitlement。实际 `www.science.org` landing 或可信来源明确提供的 asset origin
才是更强证据。

robots 对通用 user-agent 禁止 `/action`、`/search`、`/media`、`/author` 等范围，同时为
少数动作给出 allow，包括 `showFeed`、`showJournal`、`showXml`、`showCoverImage` 和
`downloadSupplement`。这些规则要精确解释：

- 允许 XML/feed/topic/cover crawler path 不证明它们是 PDF 或授权全文 API；
- `downloadSupplement` 明确是 supplement，不能成为 `primary-pdf`；
- 未被 robots 禁止的文章路径也不自动获得批量 PDF 下载许可；
- robots 没有提供数值并发、文章间隔、窗口额度或账号 policy。

因此 Profile 不声明专属 Public route。可信 Metadata/OA 来源若明确给出安全 Science PDF 或
landing `AssetHint`，通用第一层仍可逐项尝试，并继续经过实际字节、PDF reader、页面树、
文章身份、来源依据、许可证和不可变发布检查；不会根据 DOI 合成 `/doi/pdf/` 或 `/doi/epdf/`。

## 3. 授权 API 与 Browser 结论

本轮未得到可核实的官方机器访问/PDF API endpoint、认证产品、schema、媒体类型、quota scope
或错误语义。robots 允许 `showXml` 只说明 crawler path，不说明返回内容、entitlement、许可
或稳定协议。因此 authorized API capability 为 `unsupported`。

ScanSci 记录过 Science DOI landing、`/doi/epdf/`、`/doi/pdf/` 与一个
`pdf_response_captured` success，同时建议其参考实现使用持久 Browser profile 并处理机构 SSO/CAPTCHA。
该单样本无法证明它是公开、机构授权还是长期 URL 合同，更不能形成批量 Browser 权利。
SciRetriever 不复制 Cookie、CARSI、CAPTCHA/反检测、selector、URL 模板或 verdict。

当前实现没有 Science 专属 Browser route、规则、selector 或调度组。Acquisition 从可信
Science landing/asset hint 或安全 DOI resolve 形成文章起点，统一进入 `browser:generic`；Agent
根据稳定页面观察选择封闭动作，Network 负责页面稳定、动作执行和 capture，Acquisition 再用目标
DOI、标题、作者、起点 lineage 和 PDF 字节排除 supplement、media/XML 与 wrong-article。自动流程
不导入或读取 Cookie，也不执行认证。`browser_probe_enabled = true` 只允许配置中心打开 Science
首页检查 runtime/目标可达，不能下载正文或证明 entitlement。

以下 Revision 3/4、`science-aaas-pdf@*`、Science lane 和 Challenge 子生命周期描述均是
2026-08-21 至 2026-09-04 旧规则执行器的历史证据，用于保留当时观察到的页面与 capture 差异；
它们不是当前 runtime 合同，不能证明 `browser:generic` 的成功率。

Revision 3 的新增证据日期为 2026-08-21，只为 Science/AAAS 规则声明受限的 Cloudflare
dependency：精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。
它不加入 Science 的普通 `allowed_origins`；只有当前 Science Publisher 页面或其 frame ancestry
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

CBA72 将 Science / AAAS 的旧服务器现场准入记为 `deferred`。这不降低 Profile 的
`production-ready` 工程状态，也不等于其它机构/Profile 全局 unsupported；它只表示固定代表
样本在旧执行器中停在持续自动验证且没有可验证 PDF。

Profile 的 `production-ready` 只表示该访问画像、证据 fixture 和首页 probe 合同闭环；它不表示
Science 拥有专属 Browser 下载实现。官方未发布数值 pacing、当前 IP 和 live entitlement 未核实
仍作为 evidence gap 保留。Science 与 PNAS 共享页面模板、CDN 或 PDF path 也不会改变通用
Browser 的安全准入与文章归属验收。

## 4. 资产归属与当前实现

可信 locator 得到的 PDF 必须证明是目标文章正文。通过 `downloadSupplement` 得到的文件始终
属于 supplement；XML、media、cover、loading 页面和 wrong article 不能成为 `primary-pdf`。
URL 中出现 DOI 或 `pdf` 只是一项 locator 线索。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 Profile fixture 为
`tests/fixtures/acquisition/profiles/science-aaas.json`。Fixture 证明弱/强 DOI 边界、robots 的
XML/supplement allowance 不生成主 PDF、无授权 API、首页 probe 和上游 Browser success 非授权
证据；它不再保存页面规则、Publisher lane 或文章下载准入。通用 Browser 与文章身份验收由共享
Browser/Acquisition 测试覆盖，测试材料不保存真实 DOI、正文、Cookie、账号、机构或 Browser
Profile 内容。

Profile 已进入 production catalog，但只为访问画像解析和首页 probe 提供事实。真实文章只有在
Public/API 正常结束、强起点证据成立、Browser 显式启用且 runtime 就绪时进入
`browser:generic`。它不新增 Science credential section；无权限或未命中时仍可由用户独立手动
接纳 PDF。

2026-09-04 的旧规则执行器隔离真实 Browser 验证观察到：通过页面 PDF 操作触发的正文响应使用同源
`/doi/pdfdirect/` 路径族，首次为 HTTP 200，随后为多个 206 range 响应，媒体类型为
`application/pdf`。旧 @3 规则因只登记 `/doi/epdf/` 与 `/doi/pdf/` 而在读取正文前安全拒绝这些响应。
@4 当时仅增加该精确静态路径族，仍要求已准入的 Science origin、PDF 媒体类型和目标 DOI 路径
身份；不会放宽为任意同源 PDF，也不会接纳 supplement、其它 DOI 或 query 证据。当前执行器不再
消费 @4 规则，但这项观察仍可用于通用 capture/identity 回归用例。
