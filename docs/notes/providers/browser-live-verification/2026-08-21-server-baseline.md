# 2026-08-21 服务器 Browser 脱敏基线

- 观察日期：2026-08-21（Asia/Shanghai）
- 代码基线：`bb49fa8`（persistent publisher runtime）；对应正式说明为 `3f0cf2a`
- 样本：九个 production Browser access key 各一篇，共 9 篇
- 性质：切换 CloakBrowser 和 challenge 生命周期前的时点对照，不是成功率、授权或长期准入结论

## 1. 证据边界

原始运行材料只保存在 Git 忽略的本机运行目录
`work/browser-persistent-server-smoke-20260821/`，不属于项目真相源或发布物。本文只收录允许长期比较
的脱敏事实；原始 DOI、页面截图、页面正文、完整 URL/query、PDF、Catalog、Cookie、Profile、IP、
环境变量、凭据和签名 locator 不复制进正式文档。

九个样本以 `B01`–`B09` 稳定引用，并按 access key 固定映射：

| 样本 | Access key | 结果 |
| --- | --- | --- |
| B01 | `acs-publications` | challenge，未交付 PDF |
| B02 | `aip-publishing` | challenge，未交付 PDF |
| B03 | `elsevier-sciencedirect` | HTTP 200 challenge 页面，未交付 PDF |
| B04 | `iopscience` | 捕获并提交有效 primary PDF |
| B05 | `oxford-academic` | challenge，未交付 PDF |
| B06 | `rsc-publishing` | challenge，未交付 PDF |
| B07 | `science-aaas` | challenge，未交付 PDF |
| B08 | `springerlink` | 捕获并提交有效 primary PDF |
| B09 | `wiley-online-library` | challenge，未交付 PDF |

整体结果为 2/9 成功、7/9 进入验证页。这个数字只描述该时点、该服务器出口、每家一篇的
Browser-only 样本，不能外推为完整 Public/API/Browser 流程或任一 Publisher 的长期成功率。

## 2. 已证明的现有成功链

B04 与 B08 都完成了：强访问方证据 → production rule → Browser admission → response capture →
实际 PDF magic/reader/页面树检查 → SHA-256/不可变对象发布 → 唯一 `primary-pdf` 关系 →
`ASSET_READY`。对应实现和离线证据主要位于：

- `src/sciretriever/acquisition/` 的 profile catalog、Browser rules、tiered service 与统一 PDF 验收；
- `src/sciretriever/network/` 的 Browser session、CONNECT、route guard、capture 与清理；
- `tests/test_browser_sessions.py`、`tests/test_network_browser.py`、
  `tests/test_browser_provider_cloakbrowser.py`、`tests/test_acquisition_browser.py`、
  `tests/test_acquisition_matrix.py` 和 `tests/test_publisher_profile_verification.py`。

两份真实资产只留在忽略的运行目录；本文不记录其 hash、大小、页数或内容，避免把真实文献资产
变成正式仓库材料。

## 3. Runtime、调度与出口事实

- 同一 operator-managed Profile；有头 Chromium 由 Xvfb 提供虚拟显示。
- 合并观察中的三个 Publisher lane 共用一个 Browser process 和一个 persistent context；结束时
  `lane-count=3`、`process-count=1`，关闭后没有残留 Chromium 或 Xvfb。
- 每家仅一篇且 `execution.max_concurrency=1`，因此本次不能证明同组真实文章间隔；离线测试已证明
  不同组可并行、同组固定串行和统一 PDF 发布，但真实 A/B 必须重新记录组内间隔。
- Browser 经过 SciRetriever loopback CONNECT 后的脱敏出口 fingerprint 与禁用环境代理的 direct
  socket 相同，与环境代理出口不同；因此应用没有使用 `HTTP_PROXY`、`HTTPS_PROXY` 或
  `ALL_PROXY`。这不能排除机房 NAT 或透明上游。
- 运行目录最早与最晚证据文件的 mtime 窗口约为 80 分 20 秒；它混合了九篇运行与后续诊断，不能
  作为逐 Publisher 延迟或性能比较。切换门 A/B 必须以 monotonic clock 重新记录 route elapsed、
  settle elapsed、组内间隔和 process reuse。

## 4. Challenge 根因基线

七家失败页都具有高特异性的验证页证据；其中 Elsevier 返回 HTTP 200，说明状态码本身不能决定
challenge。页面运行表面为：

```text
navigator.webdriver = true
navigator.plugins.length = 0
navigator.languages.length = 2
User-Agent 不含 HeadlessChrome
```

当前 Provider allowed origins 不含 `https://challenges.cloudflare.com`。Publisher 页面发起的
challenge iframe/script 被本地 destination guard/CONNECT 边界拒绝，页面停在不完整验证状态；
初次状态检查随后把资源阻断、自动验证中和人工交互统一收敛成笼统 challenge failure。

一次独立 ACS 诊断只临时允许精确 Cloudflare origin，没有修改生产配置或点击页面。Publisher 与
challenge origin 请求都能建立，真实 `Verify you are human` 控件出现；2 秒和 12 秒检查点均未
自动完成。这证明两个独立问题：SciRetriever 会先阻断必要资源；资源加载完整后，当前 runtime
仍可能明确需要人工交互。CloakBrowser 或 settle 不能被写成 CAPTCHA 绕过或 entitlement 保证。

目标对照状态固定为：

```text
resource-loading
settling
cleared
interaction-required
resource-blocked
settle-timeout
failed
```

`resource-blocked` 说明本地实现/配置缺口，不得打开“用户需要点击验证码”的 circuit；只有明确互动
控件才形成 `interaction-required`。裸 403 仍不能冒充 challenge、无订阅或 IP block。

## 5. 相邻基线缺口

- `config test --browser springerlink` 曾因合法最终页面跳离起始 origin 报不可达，而同一环境的真实
  Springer 文章成功；probe 存在假阴性，后续必须按 rule 允许的最终 origin 判断。
- Completion Report 含目标失败时进程仍可能退出 0；这只是被观察到的当前行为，不是已接受的最终
  CLI 合同，必须另行固定完全成功、局部/全部失败、取消、配置和系统错误的退出码组合。
- 每家一篇不足以证明稳定 entitlement、长期成功率、Publisher 规则稳定性或组内真实 pacing。
- 本基线没有调用 Browser Agent，也没有证明 CloakBrowser binary、固定 fingerprint 或 Cloudflare
  自动 clear；这些只能由后续离线 fixture、fresh wheel 和获授权的极小真实串行 A/B 证明。

## 6. 后续比较规则

后续 A/B 只能比较相同 access key、匹配样本/顺序、隔离的程序创建 Profile、同一服务器 direct
出口和相同预算下的：route admitted/attempted、challenge dependency admitted/blocked、settle
终态、Agent 是否调用及动作数、capture/PDF validation、elapsed、组内间隔和 process/context reuse。
出现账号警告、MFA 或持续人工 challenge 时停止对应组。任何真实材料仍只进入用户授权的
`work/` 目录，正式文档只保留脱敏结论。
