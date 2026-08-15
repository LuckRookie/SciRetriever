# ACS Publications

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；ACS Publications 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://pubs.acs.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public、授权 PDF API 或 Browser production route

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

当前无法建立生产 `BrowserSiteRule`：

- 没有官方、可执行的文章启动间隔/window policy；许可条款只说明 ACS 可以限制有不利影响的自动化行为；
- 匿名读取站内政策页已遇到 Cloudflare challenge，禁止用 stealth、CAPTCHA 绕过、换入口或立即重试规避；
- 没有独立核实 institutional login、authenticated/entitled、login-required、paywall/not-entitled、MFA/challenge/rate/account-warning 的封闭 marker；
- 没有独立 fixture 证明 `/doi/pdf/` 只捕获当前正文，并排除 Supporting Information、附件、图形摘要和 wrong-article PDF；
- 没有获准的 operator-managed session 现场验证，也没有证据确定 ACS 的 risk/session group 与其它 Atypon 风格站点是否共享。

所以 `acs-publications` 状态为 `unsupported`，没有 `browser_rate_limit_group`、`browser_session_key` 或 executable route。若用户以后单独授权现场核实，必须按一篇批准样本、可见 Browser、明确停止条件和供应商政策重新走统一准入门；上游历史成功不能直接改变状态。

## 5. 当前实现边界

`src/sciretriever/acquisition/profile_catalog.py` 记录了 secret-free 的 ACS unsupported Profile，唯一 evidence fixture 为 `tests/fixtures/acquisition/profiles/acs-publications.json`。Fixture 只证明 origin、弱身份、许可/TDM 结论、JATS 非 PDF、Supporting Information 不得提升和无 executable route；不包含真实 DOI、正文、Cookie、账号或响应。

安全的 ACS PDF/landing `AssetHint` 若由现有 Metadata/OA 来源明确提供，仍可经过通用第一层获取、实际字节/PDF reader/页面树检查和不可变发布。Profile unsupported 不会删除这些候选，也不会把第一层失败自动提升成 ACS Browser。当前没有新增 ACS API credential、Metadata Provider 或旧架构兼容入口。
