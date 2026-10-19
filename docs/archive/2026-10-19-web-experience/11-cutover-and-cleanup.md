# 11 切换、清理与验收

状态：Completed。唯一正式入口、旧前端删除、功能对等、最终 Full、减少动效整轮和便携包离线验收均通过。

**Outcome**：新界面成为 `/` 的默认入口，旧前端代码、样式和测试全部删除，文档与新现实一致，最终 Full 通过。完成后：

- 仓库中只剩一套 Web 前端；
- 只保留新版正式入口、当前URL与React偏好，不维护旧前端书签或设置迁移；
- 安装包可以离线运行。

**进入条件**：10 已完成；[功能对等清单](parity.md)中除本块负责的条目以外全部为“新界面通过”。

**责任边界**：

- 静态资源清单、构建脚本、`apps/web/public` 与旧源码的删除；
- 测试清理；
- 文档同步。

不修改服务端业务、API 与 CLI / MCP。

## Tasks

- [x] **11.1 切换前核验**
  - 逐项核对功能对等清单，每一行都要有新测试或明确的处置。
  - 输出“旧测试 → 新测试”对照表，统计以下数量：迁移、合并、经 Owner 同意移除。
  - 运行 03 的审计脚本，得到“最终”数据，与旧界面基线、组件基线并列，证明 03 的统一目标已经达成。
  - 性能数据汇总：
    - G3 阅读口径；
    - 点击反馈时间；
    - long task；
    - 首屏 JS 体积与预算的对比。
- [x] **11.2 GB：切换默认界面**
  - 提交 11.1 的全部材料，请 Owner 在新界面上试用一轮。可以用真实库只读浏览，不触发任何加工。
  - Owner 确认后，执行以下切换：
    - 主模式的 `/` 指向新界面；
    - 按Owner最新要求，直接撤销 `/next` 路由和旧 `workspace` URL 别名，不保留跳转周期；
    - 本机偏好仅读写当前React命名空间，删除旧键回退与一次迁移。
  - 验证正式根入口、必要 `/query`、当前参数/偏好正常；旧 `/next` 返回404，旧workspace及旧偏好键不生效。业务schema与固定证据兼容继续验证。
- [x] **11.3 删除旧前端**
  - 删除以下文件：
    - `apps/web/src/workspace/` 及旧入口：`live.ts`、`main.ts`、`demo.ts`、`overview.ts`、`navigation.ts`、`library.ts`、`synthesis.ts`、`task-view.ts`、`jobs.ts`、`knowledge.ts`、`document-reading.ts`、`feedback.ts`、`icons.ts`、`wire.ts`、`workspace-tools.ts`、`config.ts` 等；
    - `apps/web/public/` 中的 `live.html`、`index.html`、`workspace.css`、`styles.css`、`live.css`、`reading.css`；
    - 独立查询、维护和登录能力已迁入 React，删除对应旧 `query.html`、`maintenance.html`、`auth.css`，保留当前能力。
  - 删除前用 `rg` 确认没有其他调用方，例如 `preview-server.ts`、`workbench-preview.ts`、服务端测试中的静态资源断言。
  - 保留被新界面复用的框架无关模块，例如 `reading/` 引擎和 `wire.ts` 中的解析函数；需要时移动到 `app/` 下并更新引用。
  - 构建脚本只构建新工程；`assets.ts` 中的清单同步更新。
  - 删除只针对旧界面的测试，以及旧的 fixture 选择器。
- [x] **11.4 文档同步**
  - 需要更新的文档：
    - [Web 指南](../../guides/web-workbench.md)：截图、操作说明、快捷键；
    - [Web 设计基准](../../architecture/web/README.md)：设计语言 v2 定稿与实现状态；
    - ADR 0032（实现注记）、ADR 0036（Accepted 后的实施记录）；
    - [TypeScript 开发入口](../../development/typescript-foundation.md)：开发命令、热更新、依赖；
    - `apps/web/README.md` 及新目录各自的 README；
    - 根 README 的目录地图；
    - [文档映射](../../development/documentation-map.md)；
    - [依赖说明](../../notes/web-reading-dependencies.md)与第三方声明；
    - [技术文档 · 产品接口](../../architecture/technical/01-product-interface.md)，若其中有前端实现描述。
  - 检查链接，并运行 `git diff --check`。
- [x] **11.5 安装与离线验证**
  - 构建便携包：`pnpm package:portable`。
  - 在阻断外部网络的环境中安装并启动，检查：
    - 登录、文献库、阅读器、提取都可用；
    - 控制台没有 CSP 违规；
    - 没有外部请求。
  - 记录安装包体积的变化。
- [x] **11.6 最终 Full 与集中审查**
  - 运行 `SCIRETRIEVER_BROWSER_EXECUTABLE=… VITEST_MAX_FORKS=3 VITEST_MIN_FORKS=1 pnpm full`。
  - 记录：测试文件数与用例数、跳过项及原因、日志位置。
  - 对最终 diff 做集中审查，确认三点：
    - 没有夹带凭据、真实数据或构建产物；
    - 依赖变化与 02 的评估表一致；
    - 没有遗留旧代码引用。
  - 更新 README 的状态与交接信息。

## 退出条件

- GB 已确认；
- 11.1–11.6 已完成；
- 仓库中只剩一套前端；
- 文档同步；
- 离线安装验证通过；
- 最终 Full 通过。

## 恢复与交接

- Owner 已确认唯一新版并删除旧实现。后续问题在正式 `/` 入口修复，不重新引入旧界面、临时入口或旧参数兼容。
- 修复继续验证历史材料和固定证据读取，不改变已接纳的数据。

[计划入口](README.md)

## 切换影响分析与精确处置（2026-10-19，GB 已确认）

Owner 已确认“按这版定稿，检查通过后切换并删除旧前端”。关键直接检查通过后，默认入口、资源清单与构建补丁已应用，以下精确清理已执行。静态相对 import 遍历已从 React 主入口、登录、合成样本和预览入口检查：新界面不调用 `workspace/`、`reading/entry.ts` 或 `reading/frame.ts`。结果存在 ignored `sandbox/runs/2026-10-19-web-experience/audit/imports.json`。

已提前拆出的共享逻辑（语义不变）：

- `wire.ts` → `app/data/wire.ts`；旧根 re-export 文件已删除。
- `task-view.ts` 的纯查询投影 → `app/data/tasks.ts`；旧 DOM `taskElement()` 已随旧入口删除。
- `feedback.ts` 的候选真实发布状态说明 → `app/data/candidate-status.ts`。
- `demo.ts` 的纯合成状态 → `app/features/sample/state.ts`。
- 先前已拆分的 `workspace/processor-data.ts` → `app/data/processor-results.ts`；固定来源解析 → `reading/source.ts`。

保留 `browser-platform.ts`（普通 HTTP 的复制/随机 ID）、`preview.ts`、`preview-server.ts` 和 `reading/{contract,document,dom,markdown,pdf,source,state,transport}.ts`。它们是新入口真实依赖；不能按旧计划中“删除整个 reading”或“删除所有根 TS”粗暴处理。

### 源码、样式与构建

本次已删除的旧源码为整个 `src/workspace/`，以及根 `auth.ts`、`config.ts`、`demo.ts`、`document-reading.ts`、`feedback.ts`、`icons.ts`、`jobs.ts`、`knowledge.ts`、`library.ts`、`live.ts`、`main.ts`、`maintenance.ts`、`navigation.ts`、`overview.ts`、`query.ts`、`synthesis.ts`、`task-view.ts`、`wire.ts`、`workspace-tools.ts`，加 `reading/entry.ts` / `reading/frame.ts`。删除前再次遍历实际 import，新入口到旧源码的边为零。

旧 `public/{auth.html,auth.css,index.html,live.html,query.html,maintenance.html,styles.css,live.css,workspace.css,reading.css}` 已由 React 和阅读引擎替代并删除；保留 `public/core-js-LICENSE.txt`。定稿 `prototype.html` 的原文件不动。React `entry/` 的 index/auth/sample、静态 Aria CSS 以及 `src/app/styles/fonts/` 保留。原 `next/` 目录与 `build-next-assets` 命名已替换为正式工程命名。

| 文件                                         | 精确变更                                                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-workbench-assets.mjs`         | 删除 live/query/maintenance esbuild 入口和旧 HTML/CSS/copy bundle；只构建 Auth、Sample、Reader 资源与 React。                                                                                                                       |
| `scripts/build-reader-assets.mjs`            | 移除 `reading/entry.ts` → `reader.js` 打包以及复制 `public/reading.css`；保留 worker、cmaps、标准字体、wasm、KaTeX、匹配 text-layer 和许可证。引擎代码由 Vite 动态 chunk 打包。                                                     |
| `apps/server/src/workbench/assets.ts`        | 主 `/` 从 React manifest 的 index 读取，独立 query/maintenance 继续用同一 React HTML 的 `data-entry` 区分能力；保留维护的 `/query`。只暴露 build-declared hashed assets 与受控 reader 资源，不从请求路径读磁盘。旧静态 route 删除。 |
| `apps/server/src/workbench/http.ts` | 删除 `/next` 及其子路由兼容跳转，旧入口返回404；正式根入口与必要 `/query` 保留。认证、workbench grant、Same Origin 和 CSRF 不放宽。 |
| `apps/web/vite.config.mjs` | 入口为 `entry/`，构建使用 `build-react-assets.mjs`，产物位于 `dist/web/react/`，静态前缀为 `/assets/`。开发鉴权代理核验正式 `/`，不代理旧reader.js/reading.css。 |
| `apps/server/src/workbench/access.ts`        | 删除仅旧 auth 需要的 `/workspace.css` 公共许可；登录所需 `/auth.js`、`/auth.css` 保持。                                                                                                                                             |
| `apps/server/src/entry/workbench-preview.ts` | 直接使用完整 `loadWorkbenchAssets()`，不再手动加载旧 HTML/live.bundle。预览仍是合成库与明确 Browser runtime，不变成真实库入口。                                                                                                     |
| `apps/web/src/app/data/preferences.ts`、`url.ts` | 删除旧偏好键回退与一次迁移，以及旧workspace别名；当前React偏好和固定材料/证据参数保留。旧存储不读取也不清理。 |
| `apps/server/package.json`、portable 构建    | 保留 React manifest/chunks/fonts、reader 资源与 notices；禁止旧 dist 残留混入安装包。源码删除不会自动清掉 tsc/esbuild 的历史输出，正式打包必须在受控 staging 校验资源集合。                                                         |

### Fixture 与测试处置

`processor-workspace-fixture.ts` 已移除旧 live 构建分支，仅为共享合成库/服务/浏览器工厂；缺少调用方的 React `assets` 时明确拒绝。`next-workspace-fixture.ts` 提供 React 默认资源。`reading-assets-fixture.ts` / `reading-pdf-fixture.ts` / `reading-capture-fixture.ts` / `component-fixture.ts` / `next-feature-capture-fixture.ts` 都仍有新测试消费者，保留。

`browser-workbench.test.ts` 已改测 React 合成样本，不能因为旧文件名而删除；`feedback.test.ts` 保留并已改读 `app/data/candidate-status.ts`。`workspace-reading.test.ts` 中的 CRLF/非 BMP UTF-8 边界与不安全 Markdown 纯函数用例已移入 `reading-markdown.test.ts`。CLI 非法参数用例已在 `next-launch.test.ts` 保留。`remote-login-browser.test.ts` 验证非安全上下文 IP 登录/复制/hash/注销与后退，其等价新入口用例已覆盖，旧资源工厂已删除。

其余旧页面测试按 `parity.md` 逐条由React测试覆盖后移除，不能仅因 filename 有 workspace 就删。`design-audit.test.ts` 在切换前完成 old/new 基线；切换后保留新界面扫描与已记录基线，去掉构建旧 UI 的分支。历史截图放 ignored sandbox，不打包旧代码供审查。

### 服务端与安装测试：不只是替换资源文件名

| 测试                                                                         | 切换处置与必须保留的断言                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production-workbench-loopback.test.ts`                                      | 旧 live 资源工厂改正式 React；Browser 接管、运行结果、真实 publication 和页面反馈继续经实际 HTTP/对象图验收。                                                                                                                    |
| `knowledge-analysis.test.ts`                                                 | 两处旧 maintenance/query HTML+esbuild 工厂改共用 React fixture；固定 artifact、证据续读、错误绑定、迟到结果、single/long/default 语义断言全部保留。                                                                              |
| `document-read.test.ts`                                                      | `queryPageAssets()` 改正式独立 React；Unicode/无标题正文、固定版本、错误游标、范围/资源校验、迟到响应断言迁移到真实阅读器。不能只用 HTTP 单测代替浏览器用例。                                                                    |
| `synthesis-service.test.ts`                                                  | 旧表单选择器改 React 综合/维护入口；部分覆盖、scope 与固定 input、失败保留、历史产物读取及来源证据核验保留。                                                                                                                     |
| `knowledge-retrieval-migration.test.ts`                                      | 旧 query/maintenance assets 改 React；跨 schema/旧 artifact 的检索与证据仍须端到端覆盖，不能删除迁移证据。                                                                                                                       |
| `web-remote-access.test.ts`                                                  | `/live.js` 是合成私有静态路径时仍可测访问边界，也可改 hashed JS；核心是认证前拒绝、登录后允许、源校验和注销，不是某个文件名。                                                                                                    |
| `packages/contracts/test/package-entrypoints.test.ts`                        | 不再固定断言8个旧静态路径、old HTML 的 `side/main`、live.js 内容或维护6项清单；改验证 manifest 声明集合、root React入口、真实 chunk/CSS/字体/notices、认证访问、query/maintenance data-entry。安装后 Node 解析与包隔离断言不变。 |
| `portable-package.test.ts`                                                   | 旧 maintenance.js/html、reader.js/reading.css 的文件存在断言改为真实 React manifest引用闭包和reader原生资源；明确旧 UI 文件不随包分发。                                                                                          |
| `installed-public-journey.test.ts`                                           | 旧 `#browser-sessions` 改为 React 浏览器页面状态，去掉不存在reader.js/reading.css请求，补 Vite 入口/chunk/CSS；完整安装后材料/任务/配置旅程保留。                                                                                |
| `next-assets.test.ts`、`next-entry-http.test.ts`、`next-development.test.ts` | 从并行入口语义更新为唯一正式入口和旧路由404；不能删掉路径穿越拒绝、登录首次 grant、直达 query 参数或 HMR 认证的断言。                                                                                                                  |

实查比原“7个服务端测试”多出 portable 与 installed-public-journey，以及本轮新入口/开发测试。它们是删除旧文件前的实际阻断依赖，应在切换实现时一并处理。

### 已执行的精确清理清单

`sandbox/cases/2026-10-19-web-experience/cleanup-manifest.json`（ignored本机清单）列出72个精确文件，其中20个旧页面测试文件，并单列共享阅读引擎、browser-platform、React样本/pure测试、core-js许可和原始prototype等保留项。主代理关键检查通过、切换代理应用静态构建/入口补丁之后，重新检查引用并逐个删除了全部72个清单文件；旧workspace目录在全部列定文件删除后作为空目录移除。保留项全部仍在，不涉及用户数据或其它目录。`design-audit.test.ts` 现仅审查生产 React 资源；历史基线保留在 ignored sandbox，不再为了审计保留第二套界面。最终类型/Full 验证另在本块记录。

## 单一入口决定与重新验收

第一轮清理后的 `pnpm full` 已完整退出0：285个文件、1981项用例、无跳过，包含真实已安装Cloak对合成材料的Browser旅程，日志为 `sandbox/runs/2026-10-19-web-experience/final/full-with-cloak.log`。随后Owner明确要求取消所有旧前端兼容、以新版为准，因此该次通过不代替最终代码的复核。

本次追加清理只针对前端入口、URL别名、旧偏好和构建命名；历史catalog、文档/知识/结果schema、固定证据、CLI/MCP与认证合同均不因此移除。旧偏好不自动导入，也不主动删除。最终验收须使用根URL与新静态前缀，重新运行Full与离线安装。

正式根路径相关定向回归7文件24项通过。最终页面矩阵已保存到 `sandbox/runs/2026-10-19-web-experience/final/design/summary.json`：9个默认页 × 4宽度 × 4主题，共144条记录；水平溢出、低文字/焦点对比候选、迁移占位与运行时style节点均为0，另人工抽看3张截图。该矩阵证明当前默认页面；浮层、错误、提交及阅读状态由功能测试补充，不声称穷举所有状态或macOS环境。

03的历史取证方式、macOS环境覆盖、07的可靠语义边界及12的离线范围均已在对应块和总计划明确处置。用户已确认的结构与动效不重复询问；当前业务功能、安装/CSP和最终Full仍必须通过。

## 最终 Full 与生产回归

本次单一正式入口、URL/偏好撤销兼容、列表性能修复和减少动效修复后的 `pnpm full` 已退出0：**285文件 / 1,981项全部通过、无跳过**，包括Quick、全部Vitest和生产构建。测试阶段1,014.80秒；日志为 `sandbox/runs/2026-10-19-web-experience/final/full-root.log`。运行提供本机测试Chromium和已安装Cloak fixture，所有业务输入与服务响应均为合成/本机边界。

生产版减少动效整轮为 **36文件 / 84项通过、无跳过**，日志 `final/reduced-final-production.log`。最终生产版144默认页面矩阵也重新执行（`final/design-production/summary.json`），无溢出/低对比候选/占位页；抽看3张最终截图。独立计时、修复前后数据和采样限制分别见06、07、10。

最终便携包离线验证已通过，11.1–11.6全部收口。

### 最终便携包验收

`pnpm package:portable --output /tmp/sciretriever-web-root-verified-20261019` 与使用包内Node的离线浏览器检查均退出0。运行本机合成临时home，真实模型调用0，准备材料仅调用1次fake parser；登录、文献库、PDF、全文、持久候选结果表均可用。当前设置分区及综合来源直达返回200，旧next路径404无跳转。浏览器错误、CSP违规、外部请求及运行时style节点均0。

资源manifest含46项，包内React资源闭包精确一致；Web根目录只含auth.js/css/html、react与reader，无旧前端/并行bundle。目录文件字节合计177,200,137 B（Node 22.19，Cloak为operator-installed，符号链接不按目标重复计量），比迁移期182,137,795 B少4,937,658 B。首屏8个JS原始902,934 B、分别gzip后合计275,498 B；相对旧live基线增加106,741 B，低于120,000 B增加预算。不能把目录字节称为压缩发布包大小。

日志为 `final/portable-verified-build.log`、`final/portable-verified-offline.log`，数据为 `final/portable-verified-offline.json`。源码、文档与报告未包含用户凭据、真实材料或构建产物；未提交Git。
