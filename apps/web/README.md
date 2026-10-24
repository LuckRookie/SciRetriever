# SciRetriever Web 工作台

类型：代码导航
负责：Web 工作台的源码结构与构建
状态：现行

本目录提供以文献库为核心的人类界面、独立只读/维护页面和合成预览。正式入口为 `sciretriever web`，默认监听 `0.0.0.0:4174`，所有连接统一输入密码或启动时输出的 API key。默认存储在 `~/.sciretriever/`；自定义路径优先，修改后重启生效，不自动搬迁已有库。详见[Web 使用指南](../../docs/guides/web-workbench.md)。

## 当前实施状态

正式 `/` 已使用 [src/app/](src/app/README.md) 中的 React 工作台。静态资源使用 `/assets/`，维护服务保留 `/query`。迁移期 `/next` 入口、旧 URL 别名与旧偏好兼容已经取消，界面只使用当前 React 路由和偏好。登录页、独立查询/维护与 4173 合成样本都使用同一 React 工程，各自认证和能力边界保持。Owner 已确认本版定稿；最终 Full 与离线安装结果见[Web 体验计划](../../docs/archive/2026-10-19-web-experience/README.md)。

新界面以 React、React Aria、Motion、TanStack Query/Virtual/Table 和自有 CSS 实现，Vite 生成离线资源。Source Sans 3 / Source Serif 4 与思源黑体、思源宋体随包发布，工作台与登录页都使用，不加载 CDN；字体来源与许可证见[字体说明](src/app/styles/fonts/README.md)，其它依赖的许可证、版本与 CSP 结论见[前端依赖说明](../../docs/notes/web-frontend-dependencies.md)。界面规则见 [Web 设计](../../docs/architecture/web/README.md)。`script-src 'self'`、`style-src 'self'` 保持，不注入运行时 `<style>`。

布局与视觉以[设计内核与页面规格](../../docs/architecture/web/README.md)为准。阅读工具栏、分层信息、证据预览和公共控件按 2026-10-19 的 G4/G5 确认调整。[PRODUCT.md](PRODUCT.md) 与 [.impeccable/config.json](.impeccable/config.json) 是设计工作上下文，不替代需求、ADR 或当前行为指南，也不保存业务数据或凭据。

## 实现分工

| 目录/入口                                 | 责任                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| [src/app/](src/app/README.md)             | React 数据层、应用壳、共享组件、动效和功能页面；只持有展示/草稿，不产生第二套库事实 |
| [src/reading/](src/reading/README.md)     | PDF.js、Markdown/KaTeX、固定来源/字节验证、有界续读与会话位置；通过 ref 接入 React  |
| [entry/](entry/README.md)                 | React 主入口、登录、样本 HTML 和受控静态样式                                        |
| [public/](public/README.md)               | 阅读器兼容构建所需的第三方许可源文件                                                |
| `src/browser-platform.ts`                 | 普通 HTTP 下的明确复制和安全随机 ID 适配                                            |
| `src/preview-server.ts`、`src/preview.ts` | 只读合成样本服务器及启动/停止                                                       |
| [test/](test/README.md)                   | 临时合成库、生产静态资源与实际浏览器的离线回归                                      |

页面复用同一读取、任务、维护、配置与 Browser owner。读文献、检索和证据展开不隐式调用获取、解析或模型；加工从确认后的固定范围生成任务。独立 query/maintenance 入口保留其既有 HTTP 能力，不因共享 React 页面而获得混合工作台权限；例如独立读取支持 PDF/Markdown 下载，书目导出仍使用主工作台、CLI 或 MCP。

## 开发和预览

仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm preview:browser
```

4173 的 [合成样本](http://127.0.0.1:4173) 只绑定 loopback。React 页面提供接管、暂停/取消、模拟候选及显式确认的交互；所有文章、画面、状态和时间线都是样本，刷新即重置，没有 Application、Provider、模型、用户 home 或 catalog。静态服务器拒绝未知路径、写请求与外部连接。修改样本后重新执行预览命令构建资源；按 `Ctrl+C` 停止，不结束其它占用端口的进程。

主界面开发先运行正常工作台，再启动 Vite：

```bash
pnpm --filter @sciretriever/web dev
```

`SCIRETRIEVER_WEB_API_ORIGIN` 可指定已运行工作台的 loopback HTTP 地址。Vite 开发入口仍经过同一登录/grant 代理，HMR 的开发能力不改变生产 CSP。开发入口、API 代理和登录回跳由 `next-development.test.ts` 直接验收。

## 实时合成 Browser 预览

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench
```

4174 预览组装真实 Browser Host、JPEG、有界 SSE 和多观看者控制，但页面与 PDF 仍来自本机合成材料。入口创建自己的临时 home/Profile/catalog/资产目录，正常退出后清理；不要把真实文献放进此一次性目录。目标 Linux 运行依赖与 bundle 验证见[开发入口](../../docs/development/typescript-foundation.md)。

跨重启恢复、Candidate 持久化、不可变发布、并行文章和控制权失效由保留同一合成 home 的回归验证；静态 4173 样本不能证明这些能力。生产获取自动验收，人工确认样本不成为生产必经步骤。

## 验证

```bash
pnpm exec vitest run apps/web/test/next-reader.test.ts
pnpm exec vitest run apps/web/test/browser-workbench.test.ts
pnpm quick
pnpm full
```

浏览器测试仅访问合成 loopback 服务，使用 Playwright 测试 Chromium，或由 `SCIRETRIEVER_BROWSER_EXECUTABLE` 指定已安装测试二进制；不得改用真实库、凭据、Provider 或模型。截图、性能与一次性报告写入 Git 忽略的 `sandbox/`，不随包分发。Full 尚未完成时，局部绿色测试不代表整体迁移已验收。

[上级目录](../README.md) · [项目 README](../../README.md)
