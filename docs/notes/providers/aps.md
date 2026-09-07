# American Physical Society / Physical Review

- 官方资料最后在线核对：2026-08-15
- 配置选择键：无；APS 是 Publication/Access Provider，不是当前 Metadata Provider
- Access Platform：canonical `https://journals.aps.org`；legacy redirect origin `https://link.aps.org`
- 当前仓库接入状态：已进入 Publisher 验证矩阵，状态为 `unsupported`；无专属 Public 或授权 API，Profile 不提供首页 probe；具有合法文章起点的目标仍可使用 `browser:generic`

## 1. 官方入口与本轮证据边界

- [Physical Review journals platform](https://journals.aps.org/)：当前 canonical 文章平台。
- [APS journals terms endpoint](https://journals.aps.org/info/terms)：官方条款入口；本轮匿名请求返回 Cloudflare 403，正文未核实。
- [journals.aps.org robots.txt](https://journals.aps.org/robots.txt)：主站 crawler/content-signal 与路径政策。
- [link.aps.org robots.txt](https://link.aps.org/robots.txt)：legacy redirect origin 的官方说明。

本轮只匿名读取两个官方 `robots.txt`，并对官方首页、条款入口和信息页做有界状态核对；没有
访问文章正文、跟随真实 DOI、打开 PDF、登录机构账号、读取 Cookie/profile、调用真实 API 或
绕过 Cloudflare。主站和条款入口在当前环境返回 403 challenge，因此本 Notes 不复述无法核实
的条款内容，也不把 ScanSci 的历史访问结果提升为官方事实。

## 2. 两个 origin 的职责不同

`link.aps.org` 的官方 robots 文件明确说明该 origin 的每条 route 都是 redirect，并将 legacy
AIP 和 PROLA citation links 301 到 canonical `journals.aps.org` URL。它没有自己的文章正文
或 PDF 合同。因此：

- `link.aps.org` 可以作为 landing/redirect 识别证据，但不能被当作独立内容平台；
- redirect 后仍必须重新执行 HTTPS、DNS、origin 和 route safety 检查；
- 不从 `/doi/` 机械改写 `/pdf/`，也不把 ScanSci 观察到的 URL 模板注册为 Public route；
- PDF asset origin 当前只登记 `journals.aps.org`，而且 Profile 为 unsupported，不进入生产解析。

常见 DOI prefix `10.1103` 以及 `American Physical Society` / `Physical Review` 文本只作弱提示。
仅有 prefix 或 publisher 字符串不能证明具体 journal route、canonical landing、文章版本或
entitlement；实际安全 DOI landing 或可信来源明确给出的 APS locator 才是强证据。

## 3. Public 与授权 API 结论

主站 robots 的通用规则允许索引并声明 `search=yes, ai-train=no, use=reference`。这描述
crawler/content use signal，不是单篇或批量 PDF 下载合同；`use=reference` 尤其不能解释成
full-content 自动获取权。主站还禁止 `/search`、`/account` 和 `/login`。

因此当前只保留通用第一层行为：可信 Metadata/OA 来源若明确提供安全 APS PDF 或 landing
`AssetHint`，可以逐项尝试，并继续经过实际字节、PDF reader、页面树、文章身份、来源依据、
许可证和不可变发布检查。Profile 不根据 OA 标志、DOI prefix 或 abstract URL 合成 PDF。

本轮未找到可核实的 APS 官方公共全文 API、认证产品、endpoint/schema、媒体类型或 quota
scope。授权 API capability 因而为 `unsupported`；这不排除 APS 将来通过书面机构协议提供
机器访问，但这种协议必须形成独立 adapter 和政策证据，不能复用网页 Browser。

## 4. Browser、限速与机构访问结论

主站 robots 说明服务端通过 Cloudflare 以及负载时的 429/503 实施 rate control，并解释为何
没有 `Crawl-delay`；它没有给出可执行的 Browser article-start interval、窗口额度或账号级
policy。动态 429/503 反馈只能在已有合法路线中收紧调度，不能补出许可、初始 pacing 或页面
动作合同。

ScanSci 记录过以下待核实线索：

```text
link.aps.org/doi/{doi} -> link.aps.org/pdf/{doi}
journals.aps.org/<journal>/abstract/{doi} -> <journal>/pdf/{doi}
```

它还把 APS 标为 reusable institutional-login workflow 的 `unsupported`，并记录某一机构
OpenAthens/WebVPN/CARSI 未授权样本 PDF、`/login_inst_user` 及不要误点 `Accepted` 导航。这些
只是上游环境的历史线索：SciRetriever 不复制特定高校身份、Cookie、CARSI、URL 改写或 verdict。

当前证据不足以建立 APS 专属 Browser 页面程序或首页 probe：

- 官方访问条款正文未能匿名核实，不能确认自动 Browser 权利；
- 首页、条款和信息页当前受到 Cloudflare challenge，且没有安全的绕过授权；
- robots 允许索引不等于允许 PDF 自动化，`/account` 与 `/login` 还被明确禁止抓取；
- 缺 login、entitlement、paywall、challenge/rate/account-warning 的封闭 marker；
- 缺 primary、supplement、accepted-navigation 和 wrong-article 的现场归属 fixture；
- 缺官方数值文章间隔、持久 session 与机构 entitlement 的可推广证据。

因此没有 Browser rule、`browser_rate_limit_group` 或 session key，也不因物理学领域相近而与
AIP/IOP 共享 group。未来只有在官方许可、数值 policy、pre-hop origins、页面状态和归属规则
全部闭环后，才能为 APS 建立自己的串行 Browser 风险组。

## 5. PDF 归属与当前实现

可信 locator 实际得到的 PDF 仍必须证明是目标文章正文。Supplementary material 不得成为
`primary-pdf`；页面中的 `Accepted` 导航不能仅凭名称当成正文 PDF，accepted manuscript 也要
明确验证文章身份和版本；metadata/loading 页面或其它文章必须排除，不能只凭 `/pdf/` 字符串
接纳。

secret-free Profile 位于 `src/sciretriever/acquisition/profile_catalog.py`，唯一 fixture 为
`tests/fixtures/acquisition/profiles/aps-journals.json`。Fixture 证明 redirect/canonical origin
分离、弱 DOI、索引政策不产生 PDF route、无 API/Browser、supplement 排除和上游 verdict 非
生产证据；不保存真实 DOI、正文、Cookie、账号、机构或 Browser profile。

`unsupported` Profile 不进入 production catalog，不新增 APS credential section，也不会启动
Browser。替代路径仍是现有通用 Public/OA 来源和用户独立的手动 PDF 接纳；两者都继续服从 R3
资产验证、provenance、lineage 与不可变发布边界。
