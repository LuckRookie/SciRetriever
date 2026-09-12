# Browser 工作台前端

本目录同时提供 4173 交互样本与 4174 实时 Cloak 工作台（见下方对应章节）。

以下静态交互样本写在 `apps/web` 中，用于确认布局、观看/接管和 Candidate 审核体验。页面、文章、候选和时间线全部是合成示例。它尚未接入 Browser Host、模型、真实画面流或 Literature API；“确认入库”只改变当前页面内存状态，刷新即重置。

## 启动预览

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm preview:browser
```

打开 [本地预览](http://127.0.0.1:4173)。服务只绑定 `127.0.0.1:4173`；按 `Ctrl+C` 停止。端口被占用时会明确退出，不会结束其它进程。修改 HTML/CSS 后直接刷新；修改 TS 后运行 `pnpm --filter @sciretriever/web build` 再刷新。

静态样本本身不需要额外第三方依赖，使用原生 DOM、CSS 和现有 TypeScript 编译器，字体与图标无需外网加载。根 workspace 的 build/typecheck、lint 和 Vitest 会覆盖新增 TS 源码与测试；锁文件仅增加 web workspace 项。

## 体验路径

1. 点击「演示获取」，查看模拟获取进度、候选与匹配证据，再点击「确认入库（演示）」。
2. 点击「人工接管」后，操作文章画面中的「View PDF」；释放控制后可以继续自动演示。
3. 底部切换「身份待确认」：候选保留，发布按钮禁用；可查看原因或放弃。
4. 切换「网络拒绝」：不会产生候选，观察面板说明拒绝原因和下一步。
5. 获取过程中暂停、接管、取消或切换场景，待执行的模拟结果不会继续落入新状态。
6. 窄屏使用「候选与观察详情」打开底部抽屉；支持 Enter、Escape、可见焦点和减少动画偏好。

画面是本地 HTML 文章，滚动和 PDF 按钮是模拟交互；不提供任意 URL 输入、真实键盘转发、外部网站浏览或多观看者控制。取消时已有候选继续保留在本次页面会话中；这不代表持久化或重启恢复。

## 文件与设计

| 文件 | 责任 |
| --- | --- |
| `public/index.html` | 工作台壳、合成文章画面、候选/观察/动态面板 |
| `public/styles.css` | 暖白与松绿设计变量、桌面布局、390px 抽屉与焦点样式 |
| `src/main.ts` | DOM 事件、受限模拟交互、反馈与定时器取消 |
| `src/demo.ts` | 仅用于样本的状态与场景，不是服务端 DTO 或业务事实 |
| `src/icons.ts` | 内联 SVG 图标，避免外部依赖 |
| `src/preview-server.ts` | 固定资产白名单，只读本地预览服务器 |
| `src/preview.ts` | 预览启动与停止入口 |
| `test/browser-workbench.test.ts` | 真实 Chromium 对样本的离线交互与响应式测试 |

界面以研究者在桌面观看页面为主：暖白 `#f5f5f0`、墨绿 `#263b33` 和松绿 `#386d50`；工作台使用系统无衬线字体，示例文章使用衬线字体；以 4px 间距为基础，6–9px 圆角、细边框和轻阴影。交互过渡约 180ms，遵守 `prefers-reduced-motion`。桌面页面画面为主，右侧集中呈现证据；窄屏改为底部详情抽屉。无需账户、凭据或模型配置。

## 验证

```bash
pnpm --filter @sciretriever/web build
pnpm exec vitest run apps/web/test/browser-workbench.test.ts
pnpm full
```

浏览器测试使用现有缓存的 Chromium，或通过 `SCIRETRIEVER_BROWSER_EXECUTABLE` 指向测试用本机二进制；仅访问测试创建的 loopback 服务。缺少二进制时测试失败，不自动下载或跳过。测试覆盖受限资产访问、人工接管、显式确认入库、身份不确定、网络拒绝、迟到结果取消、390px 布局与键盘操作，并拒绝页面外部请求和控制台错误。

样本服务器仅返回列出的静态资产，拒绝其它路径和写请求；CSP 禁止外部请求、内联脚本及动态 eval。该服务器不是产品认证控制面，不组装生产 Application，也不读取用户 home、配置、Profile、catalog 或资产。

静态样本测试只证明 4173 的离线布局与交互；真实 Browser stream、权限、Candidate 持久化与入库旅程由下方
4174 工作台及[阶段 03 证据](../../docs/plans/2026-09-07-typescript-browser-workbench/03-browser-and-acquisition.md)承担。

## 实时 Cloak 工作台

静态样本继续使用 4173。新增入口使用真实 Browser Host、JPEG 和有界 SSE、双观看者控制权及
持久 Candidate；所有网页和 PDF 仍是本机合成材料。

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench
```

打开 [实时本地预览](http://127.0.0.1:4174)。配置、Catalog、Browser Host 与业务流程均由同一个
TypeScript Application 组装，不需要 Python。Linux x64 需要已安装并校验的目标 Cloak bundle、Xvfb、
prlimit、pdfinfo 和 pdftotext。入口创建全新的临时 Profile/catalog/资产目录，正常 Ctrl+C 时清理自己的
临时目录。此一次性预览用于验证合成旅程；不要把真实材料放入该临时目录。

接管后可点击画面，或在「页面操作」选择 Download PDF。候选面板显示实际 PDF hash、字节数、页数及
身份/版本 verdict；Uncertain PDF 保留候选并显示身份待确认。可用另一个 tab 接管并使旧 tab 转为观看，
390px 下通过底部按钮打开详情。已核验候选可点击「发布到当前文献」，通过实际接纳服务写入临时文献库，
显示「已发布到当前文献」。暂停/取消保留已有候选；取消页面操作后仍可重新接管并审核候选。该入口的启动
配置已使用 TypeScript owner，模型未配置时可继续人工操作。uncertain Candidate 可以显式放弃并删除 durable
Candidate 字节；accepted Candidate 可以发布到当前文献。文献库查询与 Browser Agent 的封闭模型决策已经
接入同一 Application，预览默认仍允许用户在未配置模型时完成人工旅程。

同一合成 home 上关闭并重新组装工作台，会恢复当前文章的候选和已提交 receipt；恢复时核对候选和正式文件
字节。面板当前最多读取 100 项。一次性 `preview:workbench` 正常退出会删除自己的临时 home，下一次启动
创建新的示例；跨重启恢复由保留同一合成 home 的测试验证，不能把一次性预览当作用户资料存储入口。

新增 `public/live.html`、`public/live.css`、`src/live.ts`；服务端会话、认证 API 和组装分别位于
`apps/server/src/workbench/` 与 `apps/server/src/bootstrap/workbench.ts`。浏览器 bundle 由开发依赖
`esbuild 0.28.2` 构建，版本与已有 Vite 间接依赖一致；共享 DTO 使用 workspace contracts，不加载外部 CDN。

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm exec vitest run apps/web/test/live-workbench.test.ts
```

该测试只在明确提供目标 bundle 时运行，未配置时报告 skipped。实际运行范围与 Deferred 边界见
[会话/API 验证证据](../../migration/evidence/browser-acquisition/workbench-session-api.md)。

## 实时文献库视图

4174 实时工作台新增“文献库”入口。可搜索临时 catalog、切换五种排序、加载更多并选择真实详情；正式 PDF 和
内容 Markdown 可下载。桌面与手机均提供视图切换，详情内容以安全文本展示。选择其它文献可以通过受控
`/api/target` 切换同一 Browser Host 的 Literature 目标；有进行中的 Candidate、Agent 或发布操作时拒绝切换。
实现为 `src/library.ts`，数据来自同一认证 HTTP 服务与 Application.library，不使用静态示例结果。
详见[Web 文献库证据](../../migration/evidence/runtime/workbench-library.md)。
