# 02 技术决定与工程脚手架

状态：**Completed**。工程、依赖、CSP、开发热更新、测试入口与本块退出条件已完成；默认入口已由11切换，切换后的最终Full与离线包验收在11汇总。

**Outcome**：本块完成后，可以观察到以下结果：

1. ADR 0036 已经 Owner 确认（GA），React 前端成为正式方向。
2. 每个依赖都有许可证、锁定版本、体积，以及在真实 CSP 下的验证结论。
3. Vite + React 工程能在开发模式下热更新；生产构建离线产出，由现有服务端提供。迁移阶段使用的临时入口已经撤销，最终仅正式 `/`。
4. 新入口使用同一套登录和 API；旧界面不受影响。
5. 测试体系可以跑新界面。
6. 一份功能对等清单列出旧界面的全部能力，作为 06–11 的验收依据。

**进入条件**：

- Owner 已授权开工；
- 已读 README 中的 D1–D10、[ADR 0032](../../architecture/decisions/0032-library-centered-web-workspace.md)、[0033](../../architecture/decisions/0033-machine-interfaces-cover-web-capabilities.md)、[0035](../../architecture/decisions/0035-authenticated-remote-web-access.md)、[Web 指南](../../guides/web-workbench.md)以及 AGENTS 的依赖规则。

**责任边界**：

- 本块负责：
  - `apps/web` 的工程配置与新目录；
  - `scripts/build-workbench-assets.mjs`；
  - `apps/server/src/workbench/assets.ts` 的静态资源清单（只增加新入口）；
  - 依赖与 lockfile；
  - ADR 与开发文档。
- 本块不负责：
  - 修改 API、认证逻辑或 CSP 策略；
  - 修改旧界面的行为。

## Tasks

- [x] **2.1 起草 ADR 0036「Web 前端采用 React」**（Owner 已授权完成整个计划；ADR 与索引的 Accepted 状态由总交付同步。）
  - 背景：第二轮反馈与实测，包括原生 DOM 写法下反复出现的迟到响应、状态不一致、动效难以实现。
  - 决定：D1–D8 的要点。
  - 未采用的方案及理由：
    - 继续原生 DOM，自写 `controls.ts` / `motion.ts`；
    - Vue / Svelte：可访问组件与 TanStack 生态较弱，AI 维护熟悉度较低；
    - Preact：兼容性边角问题；
    - Web Components 组件库：与已定风格冲突；
    - GSAP：许可证限制。
  - 后果：
    - 依赖与体积增加；
    - 构建链变化；
    - 迁移期需要维护两套界面；
    - 测试需要迁移。
  - 同步：ADR 索引；ADR 0032 增加“实现技术见 ADR 0036”的注记（不改其业务决定）。
  - 状态先标为 Proposed，GA 之后改为 Accepted。
- [x] **2.2 依赖评估与锁定**（精确版本、许可、发布日期、体积和兼容补丁已核验并锁定，见[依赖说明](../../notes/web-frontend-dependencies.md)。）
  - 对以下每个包记录：许可证、所选版本（发布满两周的稳定版）、gzip 体积、维护状态、在本项目中的用途。

    | 类别   | 包                                                                                                                                   |
    | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
    | 运行时 | `react`、`react-dom`、`react-aria-components`、`motion`、`@tanstack/react-query`、`@tanstack/react-virtual`、`@tanstack/react-table` |
    | 开发   | `vite`、`@vitejs/plugin-react`、`@types/react`、`@types/react-dom`、`eslint-plugin-react-hooks`                                      |

  - 不在清单内的包需要单独说明理由。例如：
    - Floating UI 已被 React Aria 覆盖，不引入；
    - 路由库按 D7 不引入。
  - 输出：评估表，写入[依赖说明](../../notes/web-reading-dependencies.md)或新的 Web 依赖说明；锁定版本写入 `apps/web/package.json` 与 lockfile。
  - 验收：`pnpm install --frozen-lockfile` 在离线缓存下可复现。

- [x] **2.3 Vite + React 工程**
  - 新目录 `apps/web/src/app/`，按功能划分：
    - `shell/`、`components/`、`motion/`、`data/`、`styles/`；
    - `features/{library,reader,retrieval,insights,synthesis,processing,intake,tasks,browser,settings,auth}/`。
  - 每个目录都有 README（遵循 AGENTS 的目录说明规则）。
  - 配置：
    - `tsconfig` 增加 `"jsx": "react-jsx"`，严格模式；
    - ESLint 加入 React Hooks 规则；
    - Prettier 的范围覆盖 `.tsx`。
  - 开发模式：Vite dev server 把 `/api` 等请求代理到本机 workbench 服务，携带登录 cookie。命令写入开发文档。
  - 验收：
    - 开发模式下修改组件后页面热更新；
    - `pnpm quick` 覆盖 `.tsx`（格式、lint、类型检查）。
- [x] **2.4 生产构建与静态入口**
  - `scripts/build-workbench-assets.mjs` 调用 Vite 构建新入口，把产物（带 hash 的 JS 和 CSS）复制到 `apps/server/dist/web/react/`。
  - `assets.ts` 使用正式根入口和 `/assets/` 静态资源；临时路由按11的最新决定移除。
  - 离线：不引用外部 CDN 或字体。
  - 验收：
    - `pnpm build` 后启动服务，`/` 显示一个最小外壳：登录后显示当前用户可见的导航，以及从真实 API 读取的文献总数（只读）；
    - 旧的 `/` 不变。
- [x] **2.5 CSP 验证**
  - 不放宽现有 CSP。逐个依赖做最小示例：
    - React 渲染；
    - React Aria 的菜单、对话框、提示；
    - Motion 的 `animate`、`AnimatePresence`、`layout`；
    - TanStack Virtual。
  - 在真实 CSP 下检查控制台没有违规报告。
  - 特别验证：
    - Motion 的 `popLayout` 等模式是否注入 `<style>`，若注入则禁用该模式；
    - Vite 的 modulepreload 或运行时是否产生内联脚本。
  - 输出：CSP 验证记录，写入依赖评估表。
- [x] **2.6 测试接入**
  - 现有 Playwright fixture（例如 `processor-workspace-fixture.ts`）使用正式 `/` 入口。
  - 新增 `apps/web/test/next-shell.test.ts`，覆盖：
    - 登录后外壳可见；
    - 未登录时跳转到登录页；
    - CSP 无违规；
    - 旧入口不受影响。
  - 约定新界面测试**只用语义定位**：按角色、标签、文字，必要时用 `data-testid`。
- [x] **2.7 体积与性能基线**
  - 记录旧界面的基线：`live.js` 约 754 KB，gzip 后约 168 KB，以 2.7 实测为准；同时记录首屏可交互时间。
  - 设定新界面预算：首屏 JS 的 gzip 体积不超过基线 + 120 KB；PDF.js、KaTeX、Table 按需加载。
  - 用构建报告检查是否符合预算。
- [x] **2.8 功能对等清单**（旧测试、实现位置及新增缺口映射已补全，余下业务用例随 06–09 的迁移逐项验收。）
  - 补全[功能对等清单](parity.md)。该清单覆盖旧测试与补充审查能力，实际条目和回归状态以清单为准。
  - 内容来源：
    - Web 指南；
    - ADR 0032 的 G1–G3；
    - 现有 `apps/web/test/*.test.ts` 的每个测试用例；
    - 对旧界面的逐页走查。
  - 每一行包含：编号、页面、能力描述、旧实现位置、旧测试、新实现块（06–09）、新测试、状态。
  - 包括容易被忽略的能力：
    - 键盘快捷键（⌘K 等）；
    - URL 参数恢复；
    - 栏宽偏好；
    - 窄屏布局；
    - 错误重试；
    - 快速切换时的取消；
    - 资源释放；
    - 查询 / 维护独立模式。
  - 验收：现有测试文件中的每个 `it(...)` 都能在清单中找到对应行。
- [x] **2.9 GA：提交 Owner 确认**
  - 提交以下材料：
    - ADR 0036 草稿；
    - 依赖评估表（含 CSP 验证与体积）；
    - 正式 `/` 外壳演示；
    - 功能对等清单的规模，即总条目数和各页面的条目数。
  - Owner 确认后，ADR 状态改为 Accepted，并同步：
    - [TypeScript 开发入口](../../development/typescript-foundation.md)；
    - [依赖候选清单](../../notes/web-frontend-dependencies.md)：改为“当前依赖”；
    - `apps/web/README.md`；
    - 根 README 的目录地图；
    - [文档映射](../../development/documentation-map.md)。

## 集成与影响

- 新增依赖与构建步骤，安装包体积会增加，记录具体数值。
- 旧界面、API、CLI / MCP 都不受影响。
- 新入口在切换前仅作预览，不在用户指南中宣传为正式入口。

## 验证

- `pnpm quick` 与 `next-shell.test.ts`；
- CSP 验证记录；
- 离线构建复现；
- 旧界面的业务断言按[功能对等清单](parity.md)迁到React；旧资源工厂的结果不能替代新入口验收，实际通过项和旧界面的已知失败分别记录在09与11。

## 已执行的工程验证

- `pnpm install --offline --frozen-lockfile` 可重现精确依赖和 React Aria 补丁。
- `next-assets`、`next-entry-http`、`next-auth`、`next-development` 直接验证静态白名单、既有认证与CSRF、同源返回地址、生产CSP和实际React HMR；默认切换后仍保留这些边界断言。
- 迁移阶段先在临时入口验证，现已切换正式根入口；Owner最新要求删除 `/next` 路由、旧URL别名与旧偏好兼容。Vite开发通过正式登录和工作台会话获取正常cookie，不提供绕过认证的测试模式。
- React Aria固定CSS静态外置；禁止Motion的popLayout/AnimateView。真实CSP最小样例和便携包实际页面均无违规；移动WebKit逻辑仅在Chromium强制分支验证，未声称真实Safari验收。
- 迁移期首屏JS gzip 272,890 B，相对旧基线168,757 B增加104,133 B，满足增加120 KB预算。独立包自带Node22.19的合成只读旅程通过，最终切换后重测。
- 源码与测试strict类型检查已运行；全项目Quick/Full统一由11执行，不能用本块直接测试替代。
- Owner已确认当前React版本定稿及GB；本块的技术选择、锁定依赖和CSP方案不再待批准。默认入口、最终包体积与安装验收以11的切换结果为准。

## 退出条件

- GA 已确认，ADR 0036 为 Accepted；
- 依赖锁定；
- 正式 `/` 外壳可用；
- 体积预算已设定；
- 功能对等清单完成；
- 03 可以开始。

## 恢复与交接

- 某个依赖在 CSP 或许可证上不通过时，在评估表中记录原因和替代方案，并回到 GA 说明，不得私自放宽 CSP。
- Vite 不满足需求时，按 D6 退回 esbuild 加 JSX，并记录原因。

交给 03 和 04 的内容：

- 工程目录；
- 画廊入口位置（`/?view=gallery`，只在开发构建或带特定参数时可见）；
- 测试约定。

[计划入口](README.md)
