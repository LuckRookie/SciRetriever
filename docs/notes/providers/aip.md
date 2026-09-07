# AIP Publishing

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；AIP Publishing 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://pubs.aip.org`
- 当前仓库接入状态：`production-ready` Profile；无专属 Public 或授权 API route；Profile 只启用首页可达性 probe，真实文章统一使用 `browser:generic`

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

## 4. 平台与 Browser 结论

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
明确禁止。

当前实现没有 AIP 专属 Browser route、rule、selector 或调度组。可信 AIP landing/asset hint 或
安全 DOI resolve 形成文章起点后统一进入 `browser:generic`；Agent 根据稳定页面观察选择封闭
动作，Network 负责页面稳定与 capture，Acquisition 再用目标 DOI、标题、作者、起点 lineage 和
PDF 字节区分正文、supplement 与 wrong-article。Profile 的 `browser_probe_enabled = true` 只
允许配置中心打开 AIP 首页检查 runtime/目标可达，不下载正文或证明 entitlement。

2026-08-21 的 `aip-publishing-pdf@3`、独立 lane、Cloudflare dependency 和 Challenge
子生命周期 fixture，以及 2026-08-22 stock/Cloak 固定样本，均是旧规则执行器的历史证据。该
样本在有界窗口形成 `settle-timeout` 且未捕获 PDF；它只能说明当时本地没有阻断已审查的
Turnstile 资源，不能证明当前通用 Agent、组织授权、当前 IP 或文章 entitlement。

由于普通 Terms 明确限制 automated program/tool/process，operator 必须确认其组织授权和实际
用途符合 AIP 条款。显式启用通用 Browser 不是许可证明；裸 403、challenge、付费墙和正文
capture 继续作为不同页面/运行结果表达。

## 5. 当前实现边界

secret-free production Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一
Profile fixture 为 `tests/fixtures/acquisition/profiles/aip-publishing.json`。Fixture 证明弱/强
DOI 证据边界、无公共机器访问 API、自动站点访问限制和首页 probe；不再保存页面规则、调度组或
文章下载准入，也不保存真实 DOI、正文、Cookie、账号、机构或 Browser profile。

Browser 总开关关闭时通用 route 不构造可执行 adapter；启用后仍需合法文章起点和 runtime
就绪。该开关不新增 AIP credential section，也不证明当前文章 entitlement。现有通用 Public
Source 仍可消费上游明确提供且通过安全复核的单篇 locator；本轮没有执行真实 AIP 文章 probe 或
正文下载。
