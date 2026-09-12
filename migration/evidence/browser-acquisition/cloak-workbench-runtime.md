# CloakBrowser 工作台运行时切片

日期：2026-09-10。平台 Ubuntu 24.04.3 LTS / Linux x86_64，Node 22.19.0，pnpm 10.32.1。

## 已验证实现

- 运行时使用 operator 已安装的 CloakBrowser `146.0.7680.177.5`。TS Configuration 只读其 owner-only 安装清单，校验固定 archive digest、版本/平台/签名验证标记、executable hash 与包含模式位的整个 bundle hash；未执行下载或安装，也未读取个人 Profile/凭据。
- Playwright / playwright-core 锁定到 `1.55.0`，CloakBrowser 的 Node 人工化输入库锁定到 `0.5.8`。只导入 `cloakbrowser/human`；不调用 vendor launcher 的环境变量、许可、GeoIP 或自动下载路径。
- `BrowserHost` 接收 Configuration 已验证的 runtime capability；不能用任意对象冒充。每次真实运行新建专属 Xvfb，使用固定 Linux persona、语言、时区、屏幕和 Profile seed。Profile manifest 与现有 Python identity v1 的字段/canonical hash 一致；不自动接纳无 manifest 的旧 Profile。
- `BrowserNetworkProxy` 提供仅本进程持有的随机代理凭据；HTTP 走 Network 的有界请求，CONNECT 只连接 admission 已解析 IP，保留 Browser TLS 与原始出口。每个 Browser 请求仍执行 route admission；禁用 Service Worker、页面 WebSocket、QUIC/WebTransport 和非代理 WebRTC 出口。未配置代理时只允许显式准入的 loopback 页面。
- `BrowserPageRuntime` 采集有界 DOM 文本、元素引用、原生视口和 JPEG。人工化输入每个低层事件重新检查当前控制权；Agent 仅六种动作，人工 text/key 为独立合同。元素引用随 snapshot 更新；同 URL 重新加载由实际导航事件递增 document generation。
- Host 页面切换先创建新页面，再关闭旧页面；关闭由 persistent context 统一拥有。此顺序避免有头 Chrome 最后窗口关闭造成进程退出竞争。观察前先激活页面并等到视口有效，不使用 networkidle。

## 证据与限制

`apps/server/test/cloak-runtime.test.ts` 在临时 Profile 上做真实有头 loopback、人工化点击、两次冷启动、localStorage 延续和 identity bytes 不变；页面报告 `Linux x86_64 / webdriver=false / 1920×1080`。普通 Chromium 适配测试单列，不能替代该证据。

`apps/server/test/browser-host.test.ts` 验证通过真实代理观察/点击、旧元素/控制权/页面代次拒绝；`browser-network-proxy.test.ts` 验证代理认证、DNS pin、CONNECT 透明字节、超限和错误目的地拒绝。

显式指定已验证 bundle 的验收：

```sh
SCIRETRIEVER_CLOAK_BUNDLE=<operator-installed-bundle> pnpm full
```

本机 TS Full 通过：47 个测试文件 / 169 个测试，目标 Cloak 测试实际执行，日志 `/tmp/sciretriever-cloak-full.log`。普通 CI 没有 operator binary 时，该目标 runtime 旅程明确显示 skipped；CI 的 Chromium 结果不承担目标 binary 的支持声明。

实际 workspace 包与完整传递运行依赖在独立临时 store/cache 中离线安装通过；没有打包 vendor binary。后续
[正式 session/API](workbench-session-api.md)、screen/event、PDF download → Candidate → Literature 和
[Browser→MinerU→Analysis](../runtime/browser-mineru-analysis-journey.md)已经接入同一目标 runtime。真实来源、
Provider、MinerU 和 LLM 均未访问；vendor binary 仍由 operator 提供，不属于 npm tarball 自含内容。
