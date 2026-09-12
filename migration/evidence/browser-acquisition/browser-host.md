# Browser Host 直接验证

## 已验证

- `apps/server/src/browser/host.ts` 是唯一持有 Playwright `BrowserContext`、Page 集合和 Profile lock 的边界。
- Profile 在启动前用 `lstat` 检查为实际目录、当前用户属主且不允许 group/world write；不会对用户已有目录执行 `chmod`。
- 导航 URL 经过无 userinfo、无 fragment 的 admission；返回给上层的 URL 去除 query/fragment。
- 2026-09-09 使用缓存的 Chrome for Testing 148.0.7778.96：
  `/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`，以 headless 模式启动临时 Profile，访问本地 loopback HTML fixture，读取标题并关闭。
- 第二个 Host 不能取得同一 Profile 的 `browser-profile` lock；关闭后新 Host 可以重新打开该 Profile。
- Profile symlink、错误 executable 和含凭据/fragment/file scheme 的导航在 Browser action 前被拒绝。

直接验证命令：

```text
pnpm exec vitest run apps/server/test/browser-host.test.ts --reporter=verbose
```

结果：4 tests passed。

## 后续闭环与边界

本文件记录早期 headless Host 切片。后续[目标 Cloak runtime](cloak-workbench-runtime.md)已覆盖 operator-managed
wrapper、patched Chromium 和 headed display，[Browser lifecycle 矩阵](browser-lifecycle-matrix.md)已覆盖 Profile
重开/竞争、page close、Application 关闭和 SSE 重连，[Transfer](browser-transfer.md)已覆盖
navigation/redirect/response/download admission。真实 Provider、宿主 SIGKILL 后 Browser 重建和未启用网络通道
仍不在首阶段支持声明内；这些边界不再把阶段 03 标为进行中。
