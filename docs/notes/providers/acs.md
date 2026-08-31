# ACS Publications

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；ACS Publications 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://pubs.acs.org`
- 当前仓库接入状态：`production-ready`；Browser rule 已进入生产 catalog，总开关启用且 runtime 就绪后逐文章检查机构 IP 访问；无专属 Public 或授权 PDF API route

## 1. 官方入口与证据

- [ACS Publications](https://pubs.acs.org/)：文章平台入口。
- [ACS Text & Data Mining](https://solutions.acs.org/solutions/text-and-data-mining/)：TDM 产品、交付格式与商业访问说明。
- [ACS Publications Terms and Conditions of Use](https://solutions.acs.org/wp-content/uploads/2025/04/ACS-Publications-Terms-and-Conditions-of-Use.pdf)：授权用户、单篇下载、系统性下载和自动化工具边界；PDF 标注为 Revised May 2021，当前由 ACS Solutions 页面公开链接。
- [ACS Publications robots.txt](https://pubs.acs.org/robots.txt)：当前 crawler 路径声明；不能替代内容许可或 Browser policy。
- [ACS Publications policy page](https://pubs.acs.org/page/policy/terms.html)：站内条款入口；2026-08-15 的匿名静态请求返回 Cloudflare challenge，未尝试绕过。

上述引用均为 `official`。本轮只匿名读取公开网页、PDF 条款和 robots 文本；没有打开文章、下载正文、登录个人/机构账号、读取 Cookie，或探测具体 Literature entitlement。

## 2. 内容、TDM 与下载授权边界

ACS 当前 TDM 页面说明其大规模内容交付面向客户方案：典型 journal article 以 JATS XML、book 以 BITS XML 交付，费用取决于数据类型和范围、访问时长、频率与交付机制，并要求联系 ACS 获取访问。这个产品不是公开 PDF API，也没有给出可以直接装配到 SciRetriever 的 PDF endpoint、认证字段或 quota scope。

公开的 ACS Publications 许可条款区分了单篇研究使用和批量行为：授权用户可以为个人学术、研究和教学用途查看、下载或打印单篇；但文章或章节不得系统性、聚合下载或集中保存供以后检索。条款还允许 ACS 对会对服务造成不利影响的 computerized/automated search、index、test 或 retrieval 工具实施限制。Metered Access Package 会按会话中每个唯一 article/chapter 的全文下载计费，系统性或 robotic 下载产生的 token 不退款。

因此“机构能够手工下载一篇”不等于“默认允许批量 Browser 获取”。SciRetriever 不能从一般订阅、IP 访问或已有页面 Cookie 推断 TDM 权利，也不能把 ACS 的 XML 数据交付产品伪装成 PDF 获取 API。

## 3. 身份、landing 与 PDF 线索

当前 Profile 只把以下证据作为弱提示：

- DOI prefix `10.1021`；
- publisher 文本 `ACS Publications` 或 `American Chemical Society`。

它们不能单独证明当前 Literature 的实际访问方。只有未来通过公开层安全解析得到的实际 `https://pubs.acs.org` landing，或由可信来源明确给出的 ACS asset origin，才能形成强访问方证据；当前 unsupported Profile 不参与 production resolver。

ScanSci 留下了以下待核实线索：

```text
article: https://pubs.acs.org/doi/{doi}
PDF:     https://pubs.acs.org/doi/pdf/{doi}
```

它还记录过一次 `pdf_response_captured`。这些是上游运行观察，不是 ACS 官方 URL 合同，也没有证明 redirect、授权失败、Cloudflare challenge、正文/Supporting Information 归属和规则长期稳定。SciRetriever 不复制其通用 selector、任意页面脚本、CARSI/Cookie 文件合同或成功 verdict。

## 4. Browser 与 Supporting Information 结论

当前已经建立技术规则 `acs-publications-pdf@3`，并用合成 fixture 验证：

- landing/asset origin 精确限制为 `https://pubs.acs.org`，DOI 只在已有强 origin 时参与文章归属；
- primary、Supporting Information、excluded 与 wrong-article 捕获分类；
- login、entitlement/paywall、challenge/rate/account-warning 等封闭页面状态；
- 独立 `acs-publications` risk/session group、组内并发 1 和 30 秒审慎 fixture 基线。

Revision 3 的新增证据日期为 2026-08-21，只为 ACS 规则声明受限的 Cloudflare dependency：
精确 origin `https://challenges.cloudflare.com`、path prefix
`/cdn-cgi/challenge-platform/` 与 `/turnstile/v0/`，且资源类型只允许 `script`、
`document`、`fetch`、`xhr` 和 `image`。它不加入 ACS 的普通
`allowed_origins`；只有当前 ACS Publisher 页面或其 frame ancestry 能给出发起与用途证明时才
可加载，不能作为初始/任意顶层导航、popup、PDF locator 或 capture source。这里记录的
`resource-blocked`、`settling`、`cleared`、`interaction-required` 与 `settle-timeout` 是
2026-08-21 旧 Challenge 子生命周期的历史 fixture 词汇，不是当前运行合同。当前运行只把它分类为
统一 `page_state=CHALLENGE`：Rules 执行已审查动作，Agent 可以使用统一元素/坐标点击；controller
停止时仍未清除则形成文章级 `challenge-unresolved`，不会打开 Challenge group circuit。该封闭规则
和本地 fixture 只证明程序没有自行挡住必要资源，不证明当前 IP、机构合同或文章 entitlement。

2026-08-22 的固定单篇真实串行 A/B 中，stock 与 Cloak 各自加载 17 个上述受限资源，本地阻断
均为 0，随后都在有界窗口形成 `settle-timeout`，没有捕获 PDF。这个结果证明当前文章绑定、
Turnstile 路径和 image 子资源没有再被 SciRetriever 自己误拦；它不证明自动验证已通过、文章有
权限或 Cloak 提高了下载成功率，也没有触发 CAPTCHA 点击。

CBA72 将 ACS 的本次服务器现场准入记为 `deferred`。这不降低其 `production-ready` 工程状态、
不删除生产 rule，也不等于其它机构/Profile 全局 unsupported；它只表示固定代表样本停在持续
自动验证且没有可验证 PDF，后续仍须逐文章判断并保留该稳定失败。

这些内容证明规则、生产对象图和离线安全验收已达到工程准入要求，但 ACS 的普通条款对系统性/
聚合下载有限制。ACS rule 进入 production catalog；operator 显式启用受控 Browser 后，它只按
`acs-publications` 组内串行和 30 秒审慎间隔做逐文章机构 IP 尝试。该启用不证明组织合同、当前
IP 或文章 entitlement，operator 仍须确保实际使用符合组织授权和 ACS 条款。付费墙、裸 403、
challenge 与正文捕获分别报告；自动 challenge 只在有界 settle 内等待自然完成，明确人工控件
出现后立即停止，不能点击或用 CAPTCHA 绕过、换入口或立即重试规避。

## 5. 当前实现边界

`src/sciretriever/acquisition/profile_catalog.py` 记录 secret-free 的 ACS production Profile，
`src/sciretriever/acquisition/sources/browser_rules/providers/acs.py` 记录技术规则，唯一 evidence fixture 为
`tests/fixtures/acquisition/profiles/acs-publications.json`。Fixture 证明 origin、弱/强身份边界、
JATS 非 PDF、正文/Supporting Information 归属和页面状态；不包含
真实 DOI、正文、Cookie、账号或响应。

安全的 ACS PDF/landing `AssetHint` 若由现有 Metadata/OA 来源明确提供，仍可经过通用第一层
获取、实际字节/PDF reader/页面树检查和不可变发布。只有 Browser 总开关启用且前两层均未命中
时，生产 Profile 才可能把目标升级到 ACS Browser；总开关不会放宽固定 origin、规则、限速、
正文归属或 Network 安全边界。当前没有新增 ACS API credential、Metadata Provider 或旧架构兼容入口；
本轮也没有执行真实 ACS 文章 probe 或正文下载。
