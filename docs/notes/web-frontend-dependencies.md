# Web 前端框架依赖与兼容性

类型：外部事实
负责：前端框架候选版本、许可与 CSP 兼容事实
状态：现行

2026-10-19 核查并安装，**当前锁定依赖；整站及最终便携包验收完成**。

本文配合 [ADR 0036](../architecture/decisions/0036-react-web-frontend.md)与 [Web 体验计划 02](../archive/2026-10-19-web-experience/02-architecture-and-scaffold.md)使用。

- 版本、许可证、发布日期来自 2026-10-19 对 npm registry 的只读查询。
- 版本、发布日期与许可证已经 registry 复核，12 个候选均存在；保守保持候选精确版本。
- 下表体积为各库选定入口的独立 esbuild 生产 bundle（包含共享/peer 依赖），**不能相加**，也不能替代最终 Vite 首屏体积。
- CSP 已完成真实策略下的依赖最小示例；便携包生产入口的登录、库、PDF、全文和提取页也已在同一策略下验证。

阅读渲染相关的依赖（PDF.js、Marked、KaTeX、fflate、@noble/hashes）继续由 [Web 阅读渲染依赖](web-reading-dependencies.md)维护；随包字体的来源、版本与许可证由[字体说明](../../apps/web/src/app/styles/fonts/README.md)维护，本文不重复。

## 选版规则

- 只选**发布满两周**的稳定版。本次以 2026-10-05 为截止日，选该日或之前发布的最新稳定版。
- 新的大版本刚发布不足一个月时，优先选上一个大版本的最后一个稳定版，并说明原因。
- 版本写入 `apps/web/package.json` 时固定为精确版本，由 pnpm lock 锁定；不顺带升级其他已锁定的依赖。

## 运行时依赖（已锁定）

| 包                        | 锁定版本 | 发布日期   | 许可证     | 用途                                                     | gzip 体积 | CSP 验证                              |
| ------------------------- | -------- | ---------- | ---------- | -------------------------------------------------------- | --------- | ------------------------------------- |
| `react`                   | 19.3.0   | 2026-09-09 | MIT        | 组件与状态模型                                           | 3,465 B   | 渲染通过                              |
| `react-dom`               | 19.3.0   | 2026-09-09 | MIT        | DOM 渲染                                                 | 69,025 B  | 渲染通过                              |
| `react-aria-components`   | 1.21.1   | 2026-09-04 | Apache-2.0 | 无样式的行为组件：键盘、焦点、按下态、弹层定位、读屏语义 | 52,127 B  | 固定样式外置后通过，见下文            |
| `motion`                  | 13.5.1   | 2026-10-02 | MIT        | 进出场、布局让位（FLIP）、指示滑动、弹簧动画             | 46,739 B  | 普通进出场/布局通过；禁用两种注入模式 |
| `@tanstack/react-query`   | 5.104.1  | 2026-10-02 | MIT        | 请求取消、去重、缓存、按推送失效                         | 13,727 B  | 合成查询通过                          |
| `@tanstack/react-virtual` | 3.14.13  | 2026-09-14 | MIT        | 长列表只渲染可见行                                       | 12,228 B  | 10,000 项窗口渲染通过                 |
| `@tanstack/react-table`   | 9.2.6    | 2026-10-04 | MIT        | 结果表：排序、选择、分页（无样式）                       | 13,395 B  | 结果表实际交互通过，无样式注入        |

## 开发依赖（已锁定）

| 包                          | 锁定版本 | 发布日期   | 许可证 | 用途                               |
| --------------------------- | -------- | ---------- | ------ | ---------------------------------- |
| `vite`                      | 8.3.2    | 2026-10-01 | MIT    | 开发服务器（热更新）与生产构建     |
| `@vitejs/plugin-react`      | 6.1.1    | 2026-08-28 | MIT    | JSX 转换与 React 热更新            |
| `@types/react`              | 19.3.0   | 2026-09-09 | MIT    | 类型定义                           |
| `@types/react-dom`          | 19.3.0   | 2026-09-09 | MIT    | 类型定义                           |
| `eslint-plugin-react-hooks` | 7.1.1    | 2026-04-17 | MIT    | Hooks 规则检查，并入 Quick 的 lint |

## 选版说明

- **Motion 选 13.5.1，不选 14.x**：14.0.0 于 2026-10-02 发布，到 2026-10-19 已经发了 14.4.0，更新非常频繁，说明这个大版本还在快速变动。13.x 自 2026-08-05 起已发布两个月，13.5.1 是它的最后一个版本。等 14.x 有版本发布满两周，且执行者确认它与本项目的 CSP 兼容后，可以另行评估升级。`motion@13.5.1` 依赖同版本的 `framer-motion@13.5.1` 和 `tslib`（前两者为 MIT，`tslib` 为 0BSD，执行者安装时以实际锁定版本的许可证为准）；`framer-motion` 是 Motion 的内部实现包，不是第二个动画库。
- **React 选 19.3.0**：registry 上更新的版本 19.3.1 发布于截止日之后。19.1.10 是旧分支的补丁版，不考虑。
- **TanStack Table 选 v9**：9.0.0 于 2026-08-04 发布，到截止日已经稳定两个月，选 9.2.6。如果执行者在 2.2 中发现 v9 的 API 或文档对无样式表格的支持不够，可以退回 v8 的最后一个版本 8.21.3（2025-04-14 发布），并在本文记录原因。
- **`@vitejs/plugin-react` 保持 6.1.1**：6.1.2 实际于 2026-10-05 发布，也符合按日截止的规则；本轮保持已评估的 6.1.1，避免安装时扩大候选变化。
- **Node 22.19.0**：Vite 与其 React 插件要求 `^20.19.0 || >=22.12.0`；TanStack Table v9 要求 `>=20`，均接受本项目基线。
- **TanStack Table v9 API**：使用 `useTable`、按功能注册的 row model；`useReactTable` 不是 v9 主入口 API。本轮不引入旧 API 兼容层。
- **`@vitejs/plugin-react` 的 peer 依赖**：`oxc-transform-react`、`@rolldown/plugin-babel`、`babel-plugin-react-compiler` 三项都标为可选（`optional: true`），不需要安装。
- 以上运行时库的 peer 依赖都接受 React 19。

## 明确不引入

| 包                             | 原因                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Floating UI                    | React Aria 已经提供弹层定位、翻转和避让屏幕边缘                                  |
| React Router / TanStack Router | 现有 URL 参数格式保持不变，由自写的小 hook 管理（ADR 0036 第七条）               |
| Tailwind、shadcn/ui、CSS-in-JS | 使用自有 CSS 与设计变量；运行时注入样式会违反 CSP                                |
| GSAP、Anime.js、AutoAnimate    | Motion 是唯一的动画引擎，不再引入其他动画库                                      |
| Testing Library 加 jsdom       | 组件测试在真实 Chromium 中运行组件画廊，复用现有 Playwright，不新增模拟 DOM 环境 |

## 兼容性注意

- **CSP**：
  - 现有主工作台的策略是：`script-src 'self' 'wasm-unsafe-eval'`、`style-src 'self'`、`style-src-attr 'unsafe-inline'`。
  - 要求：
    - 不允许内联 `<script>`；
    - 不允许运行时插入 `<style>` 元素；
    - 通过 JS 设置元素的 style 属性是允许的，Motion 动画和 React Aria 的定位都依赖这种方式。
  - **React Aria 有运行时注入，不能直接无条件采用**：
    - `usePress` 固定注入 `react-aria-pressable-style`。入口用同 ID 的静态 `<link>` 预载同一 `touch-action` 规则，利用上游已有检测自然跳过注入。
    - 移动 WebKit 的 `usePreventScroll` 没有关闭注入的配置，官方文档提供的 nonce 方案需要改变现有 CSP，本项目不采用。锁定的 [pnpm 补丁](../../patches/README.md)仅把固定 `overscroll-behavior` 规则外置，用可恢复的根元素属性启停，保留其他触摸/焦点/滚动逻辑。
    - Button、Menu、Dialog/Modal、Tooltip 在真实生产 CSP 下无违规、无 `<style>` 节点。Chromium 强制进入 iOS 分支的补充检查验证了滚动属性启停与清理；它**不等于真实 Safari 行为验收**。
  - **Motion**：`AnimatePresence mode="popLayout"` 与 `AnimateView` 确实创建 `<style>`，禁止使用；普通 `animate`、`AnimatePresence` 与 `layout` 的最小示例通过。
  - **Vite**：生产 HTML 不使用内联脚本；便携包生产入口通过，无 CSP 违规或运行时 style 节点。
- **浏览器版本**：项目的 Playwright 1.55 自带 Chromium 140，这也是测试基线。
  - Vite 的构建目标必须保证产物能在 Chromium 140 上运行，不使用该版本不支持的新 API。
  - 正式构建器显式使用 production，包括从 Vitest 调用时；完成后恢复调用方 NODE_ENV。回归检查实际产物不包含 React 的 jsxDEV 或开发栈，避免性能测量使用开发版运行时。
  - 这个问题有先例：PDF.js 曾因此改用 `legacy/build`，见[阅读依赖说明](web-reading-dependencies.md)。
- **离线**：所有依赖都打包进静态资源，不使用 CDN。许可证要并入随静态资源交付的 `third-party-notices.txt`，其中 React Aria 采用 Apache-2.0，需要保留它的 NOTICE（如果有）。
- **体积预算**：
  - 旧界面基线：`live.js` 754,456 B，gzip 后 168,757 B（2026-10-19 从当前源码以原构建选项实测）。
  - 新界面首屏 JS 的 gzip 体积不超过基线加 120 KB。
  - 阅读器、表格等按路径按需加载。
  - 2026-10-19 迁移预览便携包实测：首屏真实网络 JS 闭包 8 个文件，共 892,027 B，分别 gzip 后合计 272,890 B；相对基线增加 104,133 B，低于增加 120 KB 的预算。该值包含 React 外壳与首页按需模块，不把 PDF.js 阅读按需模块计入首屏。切换前应重新测量最终构建。

## 实测范围与维护

已执行 `pnpm install --offline --frozen-lockfile`，精确依赖与兼容补丁可从离线缓存重现。独立体积测量采用：React 的基础 hooks、ReactDOM 的 `createRoot`、React Aria 的 Button/Menu/Dialog/Tooltip/Select、Motion 的 motion/AnimatePresence/MotionConfig、Query 的 client/provider/query/mutation、Virtual 的 useVirtualizer、Table 的 useTable/flexRender。这些数据只说明所选入口的成本。

便携包使用包内 Node 22.19 启动，以新建临时 home 和合成 PDF 验证登录、文献库、PDF、解析全文和提取结果页。浏览器仅放行同源请求，模型 transport 明确禁止真实调用；实际零外部请求、零模型调用、零 CSP 违规、零 style 节点。解析仅在准备 fixture 时执行一次 fake parser。迁移期包文件合计 182,137,795 B，包含并存的新旧静态资源，不作为切换后最终包体积。静态第三方声明由构建器递归收集运行时依赖的 LICENSE/NOTICE/CopyrightNotice，并合并既有阅读器声明；`client-only` 的浏览器入口为空，npm 包没有单独许可文件，声明中如实保留其 MIT 元数据说明。

升级任何一个依赖，都要按照同样的规则重新评估。

[Notes 导航](README.md) · [ADR 0036](../architecture/decisions/0036-react-web-frontend.md) · [Web 体验计划](../archive/2026-10-19-web-experience/README.md)

## 最终单一入口产物

最终包已删除旧UI与next并行产物，采用正式 `/` 与 `/assets/`。包内Node 22.19启动，离线登录、库、PDF、全文及已保存提取结果通过，外部请求/模型调用/CSP违规/运行时style节点均0。首屏8个JS原始902,934 B，逐文件gzip合计275,498 B；相对旧基线增加106,741 B，低于120,000 B的增加预算。目录文件字节合计177,200,137 B（未捆绑Cloak），比并存期减少4,937,658 B；不是压缩归档大小。最终Full 285文件/1,981项无跳过通过。
