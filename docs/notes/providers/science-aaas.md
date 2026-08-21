# Science / AAAS

- 官方资料最后在线核对：2026-08-19
- 配置选择键：无；Science/AAAS 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：`https://www.science.org`
- 当前仓库接入状态：`production-ready`；无专属 Public 或授权 API route，已注册使用所选持久 Profile 的 Browser route `browser:science-aaas`

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

当前生产规则 `science-aaas-pdf@2` 只接受强 DOI/Science landing，精确允许
`https://www.science.org`，从 `/doi/epdf/` 或 `/doi/pdf/` 的 response/download 捕获候选，并排除
supplement、media/XML 和 wrong-article。规则包含封闭的 entitlement/paywall、login、
MFA/challenge、rate/IP/account-warning 页面状态；登录等状态只识别后停止。Browser 使用当前
机器网络出口，以及共享 persistent Profile/context 中独立的 `science-aaas` lane；组内并发 1、
项目审慎最小文章启动间隔 30 秒。自动流程不导入或读取 Cookie，也不执行认证。

该 route 的 `production-ready` 只表示 Profile/rule/policy、合成 fixture、生产对象图和安全测试
闭环；官方未发布数值 pacing、当前 IP 和 live entitlement 未核实仍作为 evidence gap 保留。与
PNAS 共享页面模板、CDN 或 PDF path 不会合并 risk/session group。

## 4. 资产归属与当前实现

可信 locator 得到的 PDF 必须证明是目标文章正文。通过 `downloadSupplement` 得到的文件始终
属于 supplement；XML、media、cover、loading 页面和 wrong article 不能成为 `primary-pdf`。
URL 中出现 DOI 或 `pdf` 只是一项 locator 线索。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，生产规则位于
`src/sciretriever/acquisition/sources/browser_rules/providers/science.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/science-aaas.json`。Fixture 独立证明弱/强 DOI 边界、robots
的 XML/supplement allowance 不生成主 PDF、无授权 API、正文/supplement/错文归属、Publisher
lane 调度和上游 Browser success 非授权证据；测试 Profile 只位于系统临时目录，不保存真实 DOI、
正文、Cookie、账号、机构或 Browser Profile 内容。

Profile 和 `science-aaas-pdf@2` 已进入 production catalog，但只在 Public/API 正常结束、强访问
方证据成立、Browser 显式启用且 runtime 就绪时启动。它不新增 Science credential section；
无权限或未命中时仍可由用户独立手动接纳 PDF。
