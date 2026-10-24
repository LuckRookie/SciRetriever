# 07 · 验收、文档与部署

类型：计划（结果块）
负责：Full、截图对照、文档同步与部署
状态：In progress；7.1–7.5 已完成，4174 已部署并通过只读冒烟；7.6 等待提交清单确认，7.7 待收尾

## Outcome

改版通过一次 Full；改版前后截图成对存档；设计文档与 Web 指南和实现一致；经授权后部署到 4174 并完成只读冒烟；经授权后分组提交。

## 进入条件

03–05 的审阅点全部确认；06 的 6.1、6.2 完成（6.3 可单独收尾）。

## 责任边界

worker 执行验收与部署；Claude 核对文档、截图与最终 diff，给出验收结论。

## Tasks

- [x] **7.1 Full**：`VITEST_MAX_FORKS=36 VITEST_MIN_FORKS=12 pnpm full`，在 tmux 中运行，结果原样记录。失败先交 Claude；修复后只重跑失败文件并记录，是否追加 Full 由 Owner 决定。
- [x] **7.2 截图对照**：`capture --label after`；生成改版前后并排的 `compare.html`。
- [x] **7.3 文档同步**〔Claude 核对，worker 修改指南〕：
  - `docs/architecture/web/design-core.md`、`page-specs.md` 与实现一致；
  - `docs/guides/web-workbench.md` 按新的侧栏与页面重写相关段落；
  - `apps/web/README.md`、`PRODUCT.md` 与组件、样式目录的 README 同步；
  - 字体许可证与依赖说明。
- [x] **7.4 部署**〔须 G-deploy〕：确认 4174 没有进行中或排队的任务；用现有停服脚本停服；构建；用现有启动脚本重启；登录密码不变且不读取、不输出。
- [x] **7.5 只读冒烟**：桌面与 390 px 各走一遍侧栏全部入口、文献库筛选与排序、打开一篇有 PDF 的文献、命令面板；不新建文件夹、不写阅读历史，除非 Owner 另行同意。记录首屏中文字体下载量与打开文献耗时。
- [ ] **7.6 提交**〔须 G-commit〕：按块分组提交，交 Owner 确认清单后执行，不 push。
- [ ] **7.7 计划收尾**：更新根 README 的最终 revision、证据、残余风险与恢复方式；状态改为 Completed，按仓库约定归档。

## 验证

见各 Task；全部结果写入交接记录。

### 2026-10-24 · 本轮 7.1 结果

- 在 tmux `sciretriever-plan14-07-full` 执行一次规定的 Full（36/12），退出码 1；Quick 通过，测试 348 文件中 327 通过、5 失败、16 跳过；2309 项中 2264 通过、5 失败、40 跳过。测试阶段 605.83 秒，Full 总计约 11 分 11 秒；链末构建未执行。
- 失败为 `web-round2-release-journey` 的旧“查看结果表”选择器、`next-retrieval` 的固定正文读取断言、`package-entrypoints` 未包含 auth-fonts 的资源白名单，以及 `portable-package` / `installed-public-journey` 直接解析带 Node 诊断前缀的 stderr。完整原文与初步判断在本机 `sandbox/reports/2026-10-24-plan14-07/report.md`、`full.log`、`full-failures.txt`。
- 未改源码，仅按授权复跑两个失败的界面文件：`next-retrieval` 6 项通过，本次未复现正文失败；`web-round2-release-journey` 同一旧选择器再次失败。定向合计 2 文件、6 通过 / 1 失败、0 跳过，109.74 秒；证据 `recheck-ui.log`，不能替代 Full 通过。1069 个代码及构建输入文件 hash 核对无变化。
- 遵守“失败先交 Claude”，保留 7.1 未勾选；7.2 暂缓、未勾选。未启动 4175，未生成 after 截图或 compare.html。未部署、未改正式库和 4174，未暂存/commit/push。下一步由 Claude 修复，是否追加 Full 由 Owner 决定。

### 2026-10-24 · 修复与 7.2 补充证据

- 7.1 修复：索引服务的错误类型改从中性 model.ts 导入，避免经同步 storage 适配器提前加载 node:sqlite。相同隔离 CLI 查询在 885e9e1 服务端源码和修复后均只输出 JSON，修复前多出 SQLite ExperimentalWarning；没有屏蔽警告、过滤 stderr 或修改两项安装旅程的 JSON.parse 断言。安装包资源白名单按实际 auth-fonts 清单逐项校验，未登记路径仍拒绝。
- 检索在 36/12、Web 全目录负载下以五份隔离副本重复执行原六项测试，最终 30/30 通过，目标复现率 0/5；整轮 57 文件/203 项通过，1 文件/1 项跳过，188.26 秒。早期诊断观察到同源正文重绘但 ready 在清空时撤销，未见 ready 过早；测试改为同一次读取同时要求 ready 和原文，原内容断言不变、不延长超时，未改 Web UI。两轮临时诊断配置/钩子失败原文均保留，未计入有效复现率。
- 最终定向：原 Full 五文件、显式启用的 production-workbench-loopback、新增 CLI 回归，共 7 文件/13 项，6 文件/12 项通过、1 文件/1 项失败、0 跳过，156.60 秒。原 Full 五文件全部通过；loopback 新失败为第 484 行等待旧 `.reader-information h2`，按文件归属要求交 Claude，未修改该文件。7.1 保留未勾选，不追加 Full；命令和失败原文见本机 `sandbox/reports/2026-10-24-plan14-07/report-b.md`、`fix-b/run-targeted.sh`、`fix-b/targeted.log`、`fix-b/loopback-handoff.md`。
- 7.2：serve 构建通过；capture --label after 在 60 篇合成样例上完成 45 页 × 1440/390 两宽度，90/90 通过、0 失败。after 位于 `sandbox/reports/design-samples/2026-10-24-after/`；`sandbox/reports/2026-10-24-plan14-07/compare.html` 按页面 ID/宽度/主题配对，共 44 个共同页面、88 对截图，新增 retrieval-results 单列 2 张。178 张图片 hash 与加载核对通过，窄屏对照页无溢出。4175 样例服务正常退出（exit 0），会话文件已清理；未操作正式库或 4174，未提交/推送/部署。

## 退出条件

Full 通过或已按规则记录；部署与冒烟完成；文档一致；计划归档。

## 恢复与交接

部署后发现问题：停服，用上一版构建重启（本计划不改表结构，构建可直接互换），问题交 Claude 判断是否回到对应块返工。

### 2026-10-24 · Claude 收尾修正与 7.3

- loopback：第 484、494 行改为等待 `.reader-information .reader-facts`（阅读信息栏不再重复标题）。在同一本机 Cloak runtime（`SCIRETRIEVER_CLOAK_BUNDLE`）下定向重跑，1/1 通过。至此原 Full 的 5 个失败文件、loopback 和新增的 CLI 回归全部定向通过；没有追加 Full。
- 7.3：页面规格并入批次 C、删除改版草案节；设计内核补充竖排标签与菜单分组；Web 指南重写文献库、阅读页、入库、全文检索、任务、设置、词表与运行记录段落；`apps/web/README.md`、`PRODUCT.md`、样式 README、字体 README 与前端依赖说明已同步，字体来源与许可证只在字体 README 维护。`node scripts/check-docs.mjs` 在计划 14 范围内 0 错误；剩余错误来自正在编写的计划 16（`docs/plans/2026-10-24-operator-plugins/`），与本计划无关。

### 2026-10-24 · Owner 授权追加 Full 后的验收

- Owner 已明确授权追加一次 Full，通过后部署 4174、只读冒烟并起草提交清单；本轮仍无暂存、commit、push 授权。
- 在 tmux `sciretriever-plan14-07-full-c` 运行 `VITEST_MAX_FORKS=36 VITEST_MIN_FORKS=12 pnpm full`，退出码 1；Quick 通过，349 文件中 332 通过、1 失败、16 跳过；2311 项中 2269 通过、2 失败、40 跳过。Vitest 536.40 秒，Full 590.92 秒；链末 build 未执行。
- 两项失败同在 `apps/server/test/browser-host.test.ts:298`：`honors an explicitly configured capacity of 7 owned sessions` 与 `honors an explicitly configured capacity of 8 owned sessions`，原文均为 `Test timed out in 5000ms.`。用例验证容量、超限拒绝和名额释放，未设置显式 timeout；上一轮同两项约 2.4 秒通过，本轮在默认 5 秒超时。仅怀疑整轮负载影响，尚未定位到启动、开页或清理阶段；不将其当成已确认根因。原五个失败文件及 200 篇复用流程本轮通过。
- 验收前后 1861 个工作区文件 hash 完全一致，其中 1255 个代码/构建输入；代码集合 SHA-256 为 `d3f975a9316e546148528519c85651cc53f341f2740a6318ec460b81db6a8918`。原始日志、失败原文、时间和 hash 核对见本机 `sandbox/reports/2026-10-24-plan14-07/deploy-c/`，完整交接见 `report-c.md`。
- 按“只有 Full 退出 0 才部署；失败就停下”执行：未改源码/测试、未重跑、未部署或启停 4174、未读写正式库或凭据。7.1、7.4、7.5、7.6 均保持未勾选；正式冒烟、字体/PDF 实测和提交清单暂缓。两项失败交 Claude；如需再次 Full，须另获 Owner 次数授权，既有条件部署授权保留。

### 2026-10-24 · Claude 处理追加 Full 的两项超时

- 失败项为 `browser-host.test.ts` 的“容量 7、8 个会话”，Vitest 默认 5 秒超时。用例本身启动真实 Chromium 并依次打开最多 9 个页面，没有耗时断言；同一文件里其它启动浏览器的用例都显式设了 30 秒。判断为 Full 负载下的测试超时设置不足，不是产品缺陷。
- 修正：给这组用例补上 30 秒超时，与同文件一致；没有改断言。单独连跑 3 次，9/9 通过，每项约 2.5–3.1 秒。
- 再跑一次 Full 需要 Owner 另行授权；既有部署授权仍以 Full 退出码为 0 为前提。

### 2026-10-24 · 再次授权 Full 的结果与交接

- Owner 在容量用例修复后要求继续完成 07，本轮再获一次 Full 及通过后的部署/冒烟/提交清单授权；在 tmux `sciretriever-plan14-07-full-d` 运行 `VITEST_MAX_FORKS=36 VITEST_MIN_FORKS=12 pnpm full`，退出 1。Quick 通过；349 文件：332 通过、1 失败、16 跳过；2311 项：2270 通过、1 失败、40 跳过。Vitest 601.08 秒，Full 662.47 秒，链末 build 未执行。
- 容量用例本轮通过，browser-host 20/20；唯一失败为 `next-launch.test.ts:84` 的 default storage 分支，等待 `address` 非空的 `expect.poll` 报 `Matcher did not succeed in time.`，原因 `expected '' not to be ''`。用例整体已有 30 秒，但该 poll 未配置独立 timeout，Vitest 默认仅 1 秒；没有 1 秒启动性能断言。未做阶段诊断或重跑，尚不能排除启动问题，交 Claude 处理。200 篇合成复用流程通过。
- Full 期间为准备恢复材料，在隔离目录重建了已提交的 `885e9e1`，构建退出 0；该构建与测试初期重叠，可能增加负载，不能据此确定失败原因。候选恢复构建尚未与运行中的 4174 核对，未将其当作已确认备份；后续验收避免同时编译恢复构建。
- Full 前后 1861 文件 hash 完全一致，含 1255 代码/构建输入；代码集合 SHA-256 为 `27cb84af18580360de1c0b52c83a41878a42b998ca69c4baa1a857c84fdb62a8`。原始日志、失败原文、冻结证据在本机 `sandbox/reports/2026-10-24-plan14-07/deploy-d/`，交接 `report-d.md`。
- 按失败门槛停下：未改源码/测试、未重跑、未部署或启停 4174、未访问正式库/凭据/真实服务，准备的 preflight/stop 脚本没有执行。正式冒烟、字体/PDF 指标与提交清单暂缓，7.1/7.4/7.5/7.6 保持未勾选；未暂存/commit/push。下一步交 Claude；再次 Full 仍需 Owner 追加次数授权。

### 2026-10-24 · Try again：Full、4174 与只读冒烟通过

- 本轮唯一一次 Full 在 tmux `sciretriever-plan14-07-full-e` 以 36/12 执行，退出 0；期间没有并行构建或其它重负载。Quick、Test、最终 build 均通过，349 文件：333 通过、16 跳过；2311 项：2271 通过、40 跳过，0 失败；Vitest 513.80 秒，整轮 573.01 秒。此前失败记录保留。
- 1861 文件验收前后 hash 一致，含 1255 代码/构建输入；代码集合 SHA-256 为 `dc9c422b0cd3569f519f061d1ca6d52f34bf69f445acc6f311d169d405fcc650`。部署构建再次核对同一源码。正式任务 0、schema 11/指纹匹配/现行检查 ready，无迁移；正常停服、确认 catalog/sidecar 无持有者后构建并沿原脚本在 tmux `sciretriever-web-4174` 重启，密码不变。
- 恢复候选 `885e9e1` 的 317 静态资源与旧在线服务逐字节一致，旧服务端/契约/资源构建保留在 `sandbox/runs/2026-10-24-plan14-rollback/`；恢复为停服后以该目录和原启动脚本重启，不替换数据库。恢复没有执行。当前 715 登记资源逐字节匹配，包含 auth-fonts.json 及其 200 个字体；匿名字体缓存与 CSP 符合要求，未登记路径拒绝。
- 1440/390 两宽度各走完全部侧栏入口、任务下 Agent、筛选排序、PDF 和双快捷键命令面板，32 场景通过。两次 reading-open 在浏览器中拦截；文献 35177、阅读历史 8、任务 8、文件夹/成员 0，前后不变；阅读历史内容 hash 及 schema hash 也不变。页面错误/HTTP 5xx/加工写请求/外部请求均 0；PDF 首页 4898 个文字字符且画布非空，出字 1412.49/1063.87 ms；首屏中文字体响应体 865456/742228 B。测量为每宽度一次 loopback 冷上下文，不宣称公网/p95 性能。
- 证据：本机 `sandbox/reports/2026-10-24-plan14-07/deploy-e/` 的 Full、冻结、部署、资源核对、smoke.json 和 32 张截图；完整报告 `report-e.md`。旧资源探针漏根页面初始化导致 401、就绪探针误用 status 属性两次脚本错误均保留并纠正，不是产品失败，未追加 Full 或改源码。
- 7.1/7.4/7.5 勾选；7.6 保持未勾选，仅生成 `commit-plan.md` 待 Owner 确认。没有暂存/commit/push、没有修改正式库结构/配置、没有调用 Provider/模型/MinerU。计划 16 排除；6.3 真实获取仍待 G-real，7.7 最终收尾/归档尚未执行。
