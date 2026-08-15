# ACM Digital Library

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；ACM Digital Library 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://dl.acm.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；ACM 论文已经开放获取，但没有符合当前政策与执行门槛的专属 Public、授权 API 或 Browser production route

## 1. 官方入口与证据

- [ACM Open Access](https://www.acm.org/publications/openaccess)：2026 年全面开放获取与 Basic/Premium 定位。
- [Digital Library Platform and Features](https://libraries.acm.org/digital-library/platform-and-features)：Basic 与 Premium 功能差异，特别是 bulk download 的归属。
- [ACM DL Policies](https://libraries.acm.org/digital-library/policies)：Basic PDF/TDM、机构与个人使用，以及 scripts/spiders 限制。
- [Authentication & Access](https://libraries.acm.org/subscriptions-access/authentication)：IP、EZproxy 与 Shibboleth 等机构识别方式。
- [ACM DL robots.txt](https://dl.acm.org/robots.txt)：当前 crawler 路径声明和 `Crawl-delay: 1`；它不是许可或稳定 PDF API 合同。

上述 URL 均为 ACM 官方资料。本轮对原始 ACM HTML 的匿名命令行请求在当前环境返回安全挑战；只对公开页面的只读文本化内容与可直接读取的 `robots.txt` 做交叉核对，没有访问论文、登录账号、使用机构身份、下载全文或绕过 challenge。

## 2. 2026 年全面开放不等于任意自动下载

ACM 官方宣布自 2026-01-01 起转为完全开放获取，所有 ACM publications 与 related artifacts 在 Digital Library 中开放。当前政策进一步说明，公开可用的 Digital Library Basic 包含所有 ACM published articles 的 PDF 和 basic text/data-mining 功能。

与此同时，官方功能页明确把 bulk downloads 列为 Premium 能力，并明确 Basic 没有 bulk downloads。当前 DL usage policy 对机构订阅者和个人订阅者都继续写明，不得使用 scripts 或 spiders 自动下载文章或 harvest metadata；违规可能导致机构下载权被临时或永久终止。公开页面没有给出可由 SciRetriever 实现的 Basic TDM endpoint、Premium bulk-download API、认证协议、请求/响应 schema、额度 scope 或单篇 PDF object contract。

因此本 Profile 必须区分三件事：

1. ACM 论文内容已经开放获取；
2. 人工使用 Basic 页面可以得到 PDF，Premium 还提供批量工具；
3. 这些事实没有自动授权 SciRetriever 通过脚本或 Browser 批量执行网页下载。

`robots.txt` 当前给出 `Crawl-delay: 1`，并允许若干 `show*Pdf` 路径，但 robots 只描述 crawler 路径偏好。它既不能推翻 usage policy，也不能证明 DOI 到正文 PDF 的稳定请求合同；SciRetriever 不把它转换成每秒一次的生产 Browser policy。

## 3. DOI、文章身份与相关材料

ACM 的常见 DOI registrar prefix `10.1145` 和 `ACM` / `Association for Computing Machinery` publisher 文本只作为弱提示。它们不能单独证明当前对象一定是 ACM Digital Library 的原文，也不能证明某个 PDF 是正文。实际 `https://dl.acm.org` DOI landing 或由可信来源明确给出的 ACM asset origin 才是更强的运行时访问方证据。

ScanSci 记录过以下页面形状：

```text
landing: /doi/{doi}
PDF:     /doi/pdf/{doi}
ePDF:    /doi/epdf/{doi}
```

其一次成功捕获使用了持久 Browser profile 和机构 Cookie。SciRetriever 不复制该 Cookie、CARSI/机构身份或 success verdict，也不把观察到的 URL 形状升级为官方长期合同。ACM 已明确 related artifacts 也开放；artifact、supplement、software/data package 即使是 PDF，也不能成为 Literature 的 `primary-pdf`。ACM Guide 中第三方 publisher 记录更不能被误认成 ACM 自有正文。

## 4. 机构认证与 Browser 结论

ACM 仍文档化 IP authentication、EZproxy 与 Shibboleth，主要用于 Premium 功能和机构识别。由于 ACM published article PDF 已由 Basic 公开，机构 Browser 不应成为获取正文的默认必要条件；登录也不能把受政策限制的自动化变成允许行为。

当前不注册 Browser route：

- 官方 usage policy 明确禁止 scripts/spiders 自动下载文章；
- Basic 无 bulk-download 能力，Premium bulk download 未公开为可执行 API；
- 没有独立核实的 login、entitlement、paywall、challenge、rate/account-warning marker；
- 没有封闭证明正文、related artifact、supplement 和 ACM Guide 第三方对象归属的页面规则；
- ScanSci 的单次机构会话成功不能替代 ACM 官方自动访问合同。

若 ACM 以后公开专门的 Basic TDM 或 Premium bulk-export API，应优先作为第一层公开协议或第二层官方授权 API 接入，并按其真实 quota scope 限速；不应先用 Browser 模拟 Premium UI。

## 5. 当前实现边界

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为 `tests/fixtures/acquisition/profiles/acm-digital-library.json`。Fixture 证明全面 OA、Basic/Premium 差异、弱 DOI 证据、related artifact 排除和无 executable route；不保存真实 DOI、正文、Cookie、账号或机构。

现有 Metadata/OA 来源若明确提供安全 ACM PDF/landing `AssetHint`，仍可由通用第一层在用户授权边界内尝试，并接受实际字节、PDF reader、页面树、来源依据和不可变发布检查。unsupported Profile 本身不合成 `/doi/pdf` URL、不启动 Browser，也不新增 ACM credential section。
