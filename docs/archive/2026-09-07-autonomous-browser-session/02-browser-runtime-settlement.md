# Block 02：Browser Runtime 与中间跳转收敛

## 状态与恢复点

- 状态：`Completed`
- 前置：Block 01 完成
- 下游：Block 03
- 恢复点：从 Network/Playwright fixture 最近一次通过的 redirect 或 settle case 恢复

## 块结果

Browser 在 Agent 动作之后允许页面完成验证、异步资源、原生 redirect、弹窗或下载；中间事件作为运行事实积累，不再因为不符合预设路径而提前结束 article lease。

## 责任与改动面

- Owner：`/root`
- 主要模块：`src/sciretriever/network/browser.py`、`src/sciretriever/network/playwright.py`、`src/sciretriever/network/browser_connect.py`
- 直接测试：`tests/test_network_browser.py`、`tests/test_network_playwright_control.py`、`tests/test_browser_connect.py`、`tests/test_network_cloakbrowser_local.py`
- 保持：HTTPS/DNS/地址类别/host admission、连接 binding、资源/时间预算、取消、清理和脱敏日志合同。

## Tasks

- [x] **ARS01 — 将中间 navigation/redirect 变成可继续事件。** 调整 response/request correlation、native redirect prebind 和 route rejection 的终态升级条件。
  - 验收：302、Challenge verification navigation 和可关联的同页 descendant 在最终稳定前不会直接把 article state 置为 policy failure。
  - 依赖：ABS01、ABS02。
- [x] **ARS02 — 降级非关键资源与暂时 DNS/连接 race。** 对明确非顶层、非 capture 关键的资源保留 blocked evidence 并继续页面；对可重试的 transient resolution/transport 使用当前 article deadline 内的有限重试/重新观察。
  - 验收：单个脚本/iframe/图片失败不终止主页面；真正未准入的初始目标、最终 PDF 目标或不可恢复 Browser 故障仍 fail closed。
  - 依赖：ARS01。
- [x] **ARS03 — 重新定义 settle。** settle 只等待足够稳定的 observation 或 candidate/terminal condition，不要求 semantic fingerprint 必须变化，也不把页面仍为 Challenge 视为失败。
  - 验收：点击后进入 `Verifying...`、短时间无变化或多次资源完成时，Agent 能收到下一次 observation。
  - 依赖：ARS01、ARS02。
- [x] **ARS04 — 补齐 Network/CONNECT/Playwright 回归。** 覆盖 redirect chain、同页/跨 origin、subframe、CONNECT 延迟授权、页面重建和清理。
  - 验收：相关 fixture 全部通过，且日志只记录安全状态/阶段，不记录 URL、query、响应正文或凭据。
  - 依赖：ARS01–ARS03。

## 执行方式与审查门

先修改 Network 的中间事件分类，再修改 Playwright/CONNECT 交接，最后跑跨模块 fixture。Block 退出时复核没有把“放宽过程判定”变成“放宽初始目标、凭据或最终 capture 的安全边界”。

## 接口、数据与依赖影响

- 运行时内部 transition/错误映射会变化；公开稳定 failure、BrowserResult、TemporaryPdf 和持久化合同不变。
- 不引入 Browser SDK、网络代理或新的异步 worker。

## 验证与退出条件

```bash
uv run --frozen python -m unittest \
  tests.test_network_browser \
  tests.test_network_playwright_control \
  tests.test_browser_connect \
  tests.test_network_cloakbrowser_local
```

退出条件：中间页面活动不会提前终止；硬性目标/预算/取消/清理失败仍能稳定终止；Block 03 可以依赖一个会持续运行直到 capture、Stop 或明确终态的 Browser 会话。

## 失败与下游交接

若必须新增跨模块事件总线或持久 Browser session 才能实现，停止并触发根 README 的大架构门。失败时回到最近通过的 redirect/settle fixture，不在 Acquisition 层堆站点例外。

## 完成证据

已完成证据：

- 相关回归命令同 Block 01，包含 Network、Playwright、CONNECT、Browser connect 和本地 CloakBrowser fixture；共 `172` 项通过，`skipped=1`。
- `uv run --frozen python scripts/harness.py quick` 通过（Ruff lint、format check、compile）。
- 通过的行为：302/异步导航/页面替换在 action deadline 内重新观察；脚本、iframe、图片等非关键资源失败局部丢弃；capture body 读取失败不再终止 Agent；settle 不要求语义 fingerprint 变化。
- 保留的硬边界：初始目标、最终 capture、DNS/地址/host admission、超时、取消、runtime 和 cleanup 仍 fail closed。
- 未覆盖：真实网络、真实机构登录状态和具体出版社的现场行为。
