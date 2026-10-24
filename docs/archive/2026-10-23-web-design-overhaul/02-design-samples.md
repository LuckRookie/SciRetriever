# 02 · 设计样例库与截图工具

类型：计划（结果块）
负责：设计样例库、页面清单与截图工具
状态：Done

## Outcome

任何人用两条命令就能：

1. 启动一个装着合成样例文献库的正式 Web（真实服务端、fake 模型、只监听 127.0.0.1）；
2. 按固定页面清单，在 1440×900 和 390×844 下截出全部页面。

这组截图就是每一轮设计的“原型”：交 Owner 审阅，也是视觉回归的对照。本块结束时产出一套**改版前基线**。

## 进入条件

01 完成（工作区干净）。

## 责任边界

worker 实现。拥有：样例数据、启动与截图脚本、页面清单、对应的冒烟测试。触达：`apps/web/test/` 现有工作区夹具（`next-workspace-fixture.ts` 与其底层 `workspace()`）、设计审计（`design-audit.test.ts`）。不改业务代码；若样例无法通过公开操作写入，先报告，不直接写 SQL。

## 样例内容要求

样例要像一个真实研究者的库，又一眼能看出是样例：

- **文献约 60 篇**：英文为主，夹杂中文标题；长标题（两行以上）、超长作者列表、缺期刊或缺年份、预印本；
- **七种建档状态都有**，数量不等（仅元数据最多，其次有 PDF、已就绪，建档中、失败、无法获取、已排除各几篇）；
- **标签**：两三个领域词表，有的文献 0 个、有的 6 个；
- **文件夹**：两层嵌套，含空文件夹；最近阅读 5 篇；
- **快照**：3 个，其中一个已过时；
- **运行记录与结果**：四种算子各至少一次；结果覆盖六种核对状态与三种按篇计数；含一次部分失败；
- **Agent 会话**：一个运行中、一个已完成、一个失败，含工具调用和长输出；
- **任务**：每种状态都有，含排队中与上次运行中断；
- **建档问题**：三四种原因各若干；
- **至少一篇**带 PDF（合成多页）、校订全文、图片与证据标记，供阅读页截图；
- 设置页显示“样例库”标记；文献标题或期刊用明显的虚构名称，避免被误当真实文献。

## Tasks

- [x] **2.1 样例种子**：`apps/web/test/design-samples-fixture.ts`，通过应用的公开操作（与现有测试夹具相同的路径）写入上述内容；导出一个可复用的 `seedDesignSamples()`。
- [x] **2.2 页面清单**：`apps/web/test/design-samples-pages.ts`，每项包含：名称、到达方式（路由或点击序列）、就绪条件、需要的交互状态（如打开菜单、勾选两行、打开对话框）。至少覆盖：
  - 文献库（默认、筛选面板展开、勾选后选择栏、文件夹视图、需处理视图、空结果）；
  - 阅读页（PDF、全文阅读、全文编辑、结果、信息栏收起）；
  - 运行算子四步对话框的每一步；
  - 算子运行记录、结果详情；快照列表与详情；词表；全文检索（有结果、无结果）；洞察；
  - 任务（列表、详情）、Agent 会话、浏览器、建档问题；
  - 设置各分区；登录页；搜索；
  - 组件画廊。
- [x] **2.3 启动与截图脚本**：`scripts/design-samples.mjs`
  - `serve`：在临时 HOME 中建样例库，启动 `web`，端口默认 4175，只监听 127.0.0.1，fake 模型，阻断外部请求；打印地址；密码只写入临时目录中权限 0600 的文件，不打印。
  - `capture --label <名称>`：按页面清单截图，输出到 `sandbox/reports/design-samples/<日期>-<名称>/`，文件名为 `<序号>-<页面>-<宽度>.png`，另写 `index.html` 把全部截图按页面排成网格，方便一次浏览；同时写 `manifest.json`（commit、时间、页面、宽度、主题）。
  - 默认只截浅色主题；`--themes` 可加深色。
- [x] **2.4 冒烟测试**（2026-10-24 复验：字体 CSP 已在 03 修复，当前界面 45 页桌面与窄屏全部到达就绪且无控制台错误，随 Web 测试目录通过）：`apps/web/test/design-samples.test.ts`：种子成功；页面清单每项都能到达就绪条件；无控制台错误。这条测试保证样例库随代码一起维护，不会悄悄失效。
- [x] **2.5 改版前基线**：在提交 `885e9e1` 的干净工作树（`git worktree add`，放在 `sandbox/` 下）中构建并 `capture --label before`，不受主工作区里 Claude 同时进行的前端改动影响；完成后移除该工作树，在交接记录登记截图路径。
- [x] **2.6 测试中的个人浏览器路径**：`apps/server/test/document-read.test.ts` 等处硬编码了个人 home 下的 Chromium 路径；改为与其它浏览器测试相同的可移植查找方式（Playwright 自带解析或环境变量），补跑相关测试。

## 集成与影响

只新增测试与脚本，不改生产代码。设计审计测试可复用 2.1 的样例。

## 验证

- `node scripts/design-samples.mjs serve` 能登录并浏览；
- `capture` 产出的页面数 × 宽度数与清单一致，无空白截图（脚本检查截图非纯色）；
- `design-samples.test.ts` 通过；
- 不访问外部网络（夹具已有的请求拦截生效）。

## 退出条件

基线截图齐全；Claude 浏览 `index.html` 确认覆盖到位。之后每个审阅单元都用同一命令产出对照截图。

## 恢复与交接

样例中某类内容无法通过公开操作造出：列出缺口和原因交 Claude 决定（降级为空状态截图或补一个测试专用入口），不绕过合同直接写库。

## 2026-10-23 · worker 交付证据

本轮只实现测试基础设施与服务端测试的浏览器路径修正，没有修改前端界面、生产业务代码、依赖或数据库结构。补丁基于 `885e9e1`；具体文件与 hash 见本机 `sandbox/reports/2026-10-23-plan14-02/`。与 Claude 同时进行的界面改动不属于本补丁。

### 已交付及使用方式

在仓库根目录的两个终端分别运行：

```bash
node scripts/design-samples.mjs serve
node scripts/design-samples.mjs capture --label review
```

`serve` 构建当前代码，以隔离的应用 HOME 创建合成库，默认监听 `127.0.0.1:4175`；终端只提示地址及口令文件位置，口令保存在 `sandbox/runs/design-samples/sciretriever-design-*/password`，权限 0600。元数据/PDF 获取端口的目的地址解析器拒绝外部请求，模型和解析器使用 fake；截图浏览器只允许访问该样例服务。就绪后 Ctrl+C 正常停止样例服务并移除口令和合成库，不影响 4174。

`capture` 输出 `sandbox/reports/design-samples/<日期>-<label>/index.html`、`manifest.json` 与 PNG；已有同名报告拒绝覆盖。默认 44 页 × 1440×900 / 390×844 × 浅色，合计 88 张；`--themes light,dark` 增加深色；`--pages library,reader-figure` 可定向核验。manifest 保存实际服务构建的 commit、工作树状态、资源清单 hash、页面路由/交互/就绪条件、宽度/主题、截图 hash、非纯色检查与失败记录。页面之间复用合成登录会话，不绕过真实认证和登录限流；组件画廊中有意展示的 Skeleton 不作为未完成加载。

### 样例覆盖

- 60 篇虚构文献：31 篇 UNREVIEWED、12 篇 ASSET_READY、2 篇 ARCHIVING、3 篇 ARCHIVE_FAILED、9 篇 READY、3 篇 EXCLUDED；其中 3 篇无 PDF 的文献有获取耗尽事实。获取耗尽是独立筛选，不新增第七种 LiteratureStatus。
- 中英文、长标题、35 位作者、缺年份/期刊、预印本；两层文件夹与空文件夹、5 篇最近阅读、0–6 个标签、3 份快照及真实内容修订造成的版本差异。
- 四类算子均经实际任务/结果服务执行，只有模型传输为 fake；包含空回答、部分失败、七类任务状态、正在运行/完成/失败的 Agent 记录与工具调用、长输出。
- 多页合成 PDF、配套的合成解析/校订全文、生成的光谱图片与可点击证据。假解析材料不用于证明 MinerU 的准确性；它仅驱动真实产品的数据流和界面。
- 样例种子无 SQL 写入：复用 Application 服务、现有夹具及公开 Repository；中断任务用 Repository 记录合成的恢复状态，明确不冒充真实进程崩溃。

### 验证与边界

并发均为 `VITEST_MAX_FORKS=36 VITEST_MIN_FORKS=12`；Vitest 命令同时指定 `--maxWorkers=36 --minWorkers=12`，确保不回退到宿主机默认并发。

| 检查                                                                                    | 实际结果                                                                                   | 本机证据                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| document-read / browser-readiness / browser-candidate-journey / browser-complex-capture | 4 文件、16 项通过                                                                          | `browser-portability.log`                 |
| browser-host 的真实 loopback 打开/关闭/复用用例                                         | 1 项通过，另外 19 项由 `-t` 未选取；没有修改 skip 规则                                     | `browser-host-portability.log`            |
| raw-parse-archive                                                                       | 25 项通过                                                                                  | `design-samples-test.log`                 |
| 当前界面的样例矩阵，首次运行                                                            | 45 项中种子 1 项通过、页面 44 项失败；43 项为同一字体 CSP 错误，1 项为测试未装配登录页资源 | `design-samples-test.log`                 |
| 冻结基线界面的相同样例矩阵                                                              | 45 项全部通过，包括每页桌面/窄屏；登录资源夹具已补齐                                       | `design-samples-baseline-test.log`        |
| 当前登录页资源装配回归                                                                  | 1 项通过，已消除夹具缺失登录资源的问题                                                     | `login-assets-final.log`                  |
| 修改文件 Prettier、ESLint、测试 strict 类型检查                                         | 通过                                                                                       | `format.log`、`lint.log`、`typecheck.log` |

冻结基线矩阵命令：先按 2.5 建立/构建 `885e9e1` 工作树，再设置 `SCIRETRIEVER_DESIGN_ASSETS_DIRECTORY=<工作树>/apps/server/dist/web`、`SCIRETRIEVER_DESIGN_GALLERY=lab`，运行 `pnpm exec vitest run apps/web/test/design-samples.test.ts --maxWorkers=36 --minWorkers=12`。不设置这两个变量时，测试始终构建并检查当前界面，不会悄悄回退到旧界面。

本轮未运行 Full 或全仓 Quick；只运行上述直接相关测试、修改文件格式/lint 与测试类型检查。尚未把默认当前界面的冒烟记为通过。

### 交给 Claude 的缺口与下一步

1. **当前界面 CSP 阻断 2.4 验收。** 当前构建把小尺寸中文字体切片内联成 `data:font/woff2;base64,…`，控制台报 `font-src 'self' blob:` 拒绝加载。应在前端构建保证字体发为同源文件（例如核查 Vite 的 `assetsInlineLimit`），不放宽 CSP、不忽略控制台错误。修复后再运行默认的 `design-samples.test.ts`；测试会保留这条回归检查。
2. **设置页“样例库”显式标记**需要界面配合。本轮没有注入 DOM 或修改产品界面；已有标题/期刊与样例目录识别信息。
3. **两种核对状态缺口**：当前算子的接纳合同不会发布无引用或失效引用的非空值，故没有伪造 `no-citation` / `citation-unavailable` 结果。真实流程样例覆盖 found / not-found / value-null / derived；六状态判定仍由既有独立合同测试负责。需展示另两种时，由 Claude 决定采用组件画廊的合成组件输入。
4. **组件基线差异**：`885e9e1` 尚无 `gallery` 路由，截图使用该版本已有的 `lab`。当前测试默认用 `gallery`。manifest 明确记录实际入口。
5. **同类 Web 测试路径**：`apps/web/test/browser-workbench.test.ts` 仍有个人 Chromium 路径。本次文件归属仅授权既有服务端测试和必要共用夹具，所以留给 Claude 修改；本轮已修复 5 个服务端测试文件的全部同类路径。
6. Claude 尚需浏览基线 `index.html` 确认覆盖，随后继续 03；当前字体错误修复前，02 不标为完全验收。

基线截图位于 `sandbox/reports/design-samples/2026-10-23-before/`，包含 88 张 PNG、网格与 manifest；`commit=885e9e12560507e17a5c5c828e49fae5dd520810`，`source_dirty=false`。额外的深色选项定向验证覆盖文献库、总结、组件页 × 2 宽度，6/6 通过，见 `2026-10-23-before-dark-check/`。截图工具的早期探针失败（登录频率、就绪选择器、画廊静态 Skeleton、窄屏图片初始滚动恢复）分别保留在 before-probe / before-probe2 / before-figure-race 报告，最终脚本按阅读就绪和字体加载完成后滚动到图片，没有修改产品滚动行为。

补充数据验收：部分失败的任务不等同于已有结果的 `incomplete` 数量；种子另运行一次读取“存在但尚未解析的补充材料”的算子，专门覆盖结果中 `incomplete > 0`，与 `empty > 0`、`with_result > 0` 分开断言。对应定向种子验收见 `seed-outcomes-final.log`，实际只读库存核对见 `inventory-check.json`。

收尾：最终基线 88/88 截图成功，截图源工作树状态干净；已正常停止本轮 4175 合成服务，移除临时口令/合成库，并通过 `git worktree remove` 移除基线工作树。没有停止或修改 4174。补充种子定向用例 1/1 通过，44 页由 `-t` 未选取，三种按篇计数均有非零样例；既有整页矩阵不重复运行。
