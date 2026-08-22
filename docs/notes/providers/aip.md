# AIP Publishing

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；AIP Publishing 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://pubs.aip.org`
- 当前仓库接入状态：`production-ready`；Browser rule 已进入生产 catalog，总开关启用且 runtime 就绪后逐文章检查机构 IP 访问；无专属 Public 或授权 API route

## 1. 官方入口与证据

- [AIP Publishing journals platform](https://pubs.aip.org/)：当前文章访问 origin。
- [Terms of Use](https://publishing.aip.org/terms-of-use/)：网站与内容使用条件，标注自 2023-04-20 生效。
- [Access](https://publishing.aip.org/resources/librarians/licensing/access/)：机构许可材料的访问、下载和学术交换边界。
- [Licenses](https://publishing.aip.org/resources/librarians/licensing/licenses/)：机构许可入口。
- [Permissions](https://publishing.aip.org/resources/researchers/rights-and-permissions/permissions/)：系统性复制、电子存储和分发的许可边界。
- [Public Access](https://publishing.aip.org/resources/researchers/open-science/public-access/)：Gold/Green OA 与版本边界。
- [pubs.aip.org robots.txt](https://pubs.aip.org/robots.txt)：当前 crawler 路径政策。

上述材料均来自 AIP Publishing 官方站点。本轮只读取公开政策、公开 REST 内容和
`robots.txt`；没有访问论文正文、登录机构账号、读取 Cookie/profile、调用真实 API、下载
PDF 或尝试绕过 Cloudflare。`pubs.aip.org/pages/terms` 的匿名请求在本轮返回 challenge，未
进行绕过；政策结论采用可公开读取的 AIP Publishing Terms 页面。

## 2. 单篇人工使用不等于自动获取许可

Terms 允许用户为个人、非商业、合法用途制作单篇文章的一份副本，也允许有限、点对点、
非系统性的学术交换；机构 Access 页面说明授权用户可在线访问已许可材料，并可为 private
use or research 下载、保存或打印。这些是人工使用和内容 entitlement，不是网页自动化合同。

Terms 同时明确禁止使用 automated program、tool 或 process，包括 crawler、robot、bot、
spider 和 automated script，访问站点或关联系统，或抽取、收集、harvest Site Content。
系统性复制、汇编文章数据库、电子存储或分发还需要单独书面许可。因此 SciRetriever 不能把
“机构用户可以下载单篇文章”推导成 Browser 可以批量执行相同动作，也不能用慢速串行消除
许可缺口。

本轮未找到 AIP 官方公开的 TDM/PDF API endpoint、请求/响应 schema、认证产品或数值 quota。
未来若 AIP 提供书面机器访问协议，应按协议建立独立授权 adapter 和 quota scope；不能把网页
URL 模板包装成 API。

## 3. OA、DOI 与资产归属

AIP 的 Public Access 页面说明 Gold OA 可使用 Creative Commons 许可证；Green OA 主要涉及
author accepted manuscript，并不等于 Version of Record PDF 的公共自动下载合同。可信
Metadata/OA 来源若明确给出某篇文章的安全 PDF 或 landing `AssetHint`，通用 Public Source
仍可逐项尝试，并继续验证实际字节、PDF reader、页面树、来源依据、许可证与不可变发布。
Profile 本身不根据 OA 标签合成 `/doi/pdf/` 或 `/doi/epdf/` 地址。

常见 DOI prefix `10.1063` 以及 `AIP Publishing`、`American Institute of Physics` 文本只作
弱提示，不能独立证明当前 Literature 的原文访问方、文章版本或 entitlement。实际
`pubs.aip.org` landing、可信来源明确提供的 asset origin，或未来官方稳定文章 ID 才是更强
证据。

正文 PDF、supplementary material 与 metadata/loading/wrong-article 内容必须保持分离。即使
可信公开 hint 或将来的授权接口交付 PDF，也只有与目标文章身份一致、通过统一 PDF 验证的
正文才能成为 `primary-pdf`；supplementary material/file 只能作为 supplement。

## 4. 平台、Browser 与风险组结论

ScanSci 记录过以下待核实形状：

```text
landing: /doi/{doi}
PDF:     /doi/epdf/{doi}
         /doi/pdf/{doi}
```

它还记录过依赖该参考项目持久 Browser profile 和机构 Cookie 的成功结果。SciRetriever 不采信该 verdict，
不复制 Cookie、机构身份或页面动作，也不把 URL 形状当作官方稳定合同。

AIP 官方站点公开内容的 CSP 曾出现 `aipprc.silverchair.com`，当前文章 origin 则为
`pubs.aip.org`。这至多是技术集成线索；它不能证明 AIP 与任何 Atypon、Silverchair 或其它
出版社品牌共享账号、风控、quota、session 或文章间隔。计划中的“AIP/Atypon”先验假设因此
没有进入生产合同。

当前 `robots.txt` 对下载、citation、登录、Shibboleth 和搜索等路径包含明确禁止项，例如
`/DownloadFile/`、`/Citation/Download`、`/signin.aspx`、`/Shibboleth.sso/` 和
`/search-results`。文章页面没有全部被 robots 禁止，也不能反过来覆盖 Terms 对自动工具的
明确禁止。当前已经建立技术规则 `aip-publishing-pdf@3`，用合成 fixture 验证 AIP 自有
origin、强 DOI 归属、primary/supplement/wrong-article 分类、封闭页面状态，以及独立
`aip-publishing` risk/session group、组内并发 1 和 30 秒审慎 fixture 基线。这些内容只证明
技术分类和安全结构，不授权真实站点执行，也不与 IOP、APS 或任何共享技术平台建立 group。

Revision 3 的新增证据日期为 2026-08-21，只为 AIP 规则声明受限的 Cloudflare dependency：
精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。它不加入 AIP 的普通
`allowed_origins`；只有当前 AIP Publisher 页面或其 frame ancestry 能给出发起与用途证明时才
可加载，不能作为初始/任意顶层导航、popup、PDF locator 或 capture source。运行时分别报告
`resource-blocked`、`settling`、`cleared`、`interaction-required`、`settle-timeout` 和普通
HTTP 403；只有自动 `cleared` 才返回正文流程，第一版不点击 CAPTCHA/Turnstile。该封闭规则和
本地 fixture 只证明程序没有自行挡住必要资源，不证明当前 IP、机构合同或文章 entitlement。

2026-08-22 的固定单篇真实串行 A/B 中，stock 与 Cloak 各自加载 17 个上述受限资源，本地阻断
均为 0，随后都在有界窗口形成 `settle-timeout`，没有捕获 PDF。这个结果证明当前文章绑定、
Turnstile 路径和 image 子资源没有再被 SciRetriever 自己误拦；它不证明自动验证已通过、文章有
权限或 Cloak 提高了下载成功率，也没有触发 CAPTCHA 点击。

CBA72 将 AIP 的本次服务器现场准入记为 `deferred`。这不降低其 `production-ready` 工程状态、
不删除生产 rule，也不等于其它机构/Profile 全局 unsupported；它只表示固定代表样本停在持续
自动验证且没有可验证 PDF，后续仍须逐文章判断并保留该稳定失败。

由于普通 Terms 明确限制 automated program/tool/process，operator 必须先确认其组织授权和实际
用途符合 AIP 条款。技术规则进入 production catalog；显式启用受控 Browser 后，只允许
`aip-publishing` 组内串行、30 秒审慎间隔的逐文章机构 IP 尝试。总开关不是许可证明，也不会把
AIP 与其它技术平台合并为共享风险组，或放宽固定规则和安全边界；裸 403、challenge、付费墙和
正文捕获分别形成不同结果。

## 5. 当前实现边界

secret-free production Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，
技术规则位于 `src/sciretriever/acquisition/sources/browser_rules/providers/aip.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/aip-publishing.json`。Fixture 证明弱/强 DOI 证据边界、无
公共机器访问 API、自动站点访问限制、平台技术名称不形成共享组，以及正文/supplement 排除；
不保存真实 DOI、正文、Cookie、账号、机构或 Browser profile。

Browser 总开关关闭时 route 不构造可执行 adapter；启用后仍需 runtime 就绪、同组调度准入和
逐文章 entitlement 检查。该开关不新增 AIP credential section，也不证明当前文章 entitlement。
现有通用 Public Source 仍可消费上游明确提供且通过安全复核的单篇 locator；本轮
没有执行真实 AIP 文章 probe 或正文下载。
