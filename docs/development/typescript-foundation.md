# TypeScript 基础开发入口

当前 TypeScript workspace 位于仓库根目录，使用 Node `22.19.0` 和 pnpm `10.32.1`。包管理器版本由
`package.json` 的 `packageManager` 字段和 `pnpm-lock.yaml` 固定；当前已有 `@sciretriever/contracts`
package、`@sciretriever/server` 的配置、凭据、Network、FileStore、SQLite、Agents、Browser、Literature、
Parsing/Analysis 切片，以及 `apps/web` 的静态样本和实时 Cloak 工作台。配置 owner bridge、Candidate 发布/放弃、
Library 与 Browser→MinerU→Analysis source-checkout loopback 旅程均已完成首阶段验收；全量迁移状态见
[活动计划](../plans/2026-09-07-typescript-browser-workbench/README.md)。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm quick
pnpm test
pnpm full
```

`quick` 执行 Prettier、ESLint、源码 project-reference typecheck 和 `tsconfig.tests.json` 的测试 strict typecheck；
`test` 执行 Vitest；`full` 追加所有已注册 TypeScript project 的 build。Lint 扫描 `packages/**/*.ts` 和
`apps/**/*.ts`。构建元数据保存在各包的 ignored `dist/`。测试文件按行为命名，例如
`contract-validation.test.ts` 和 `canonical-encoding.test.ts`。不要用块、阶段或任务顺序命名测试文件或
suite。

`package-entrypoints.test.ts` 构建并打包 contracts/server，在系统临时目录使用独立临时 store/cache 离线安装真实 tarball。
两个尚未发布的包通过临时 fixture 的 pnpm override 绑定到本次 tarball，并核对包中实际依赖版本一致；不使用远程 registry。
测试通过 Node 的包解析调用 contracts 与配置公开入口，并检查未知配置拒绝、非公开子路径拒绝和源码/测试/构建元数据
未进入安装包；随后在临时 home 创建真实 Application/SQLite/FileStore 和 WorkbenchSession，在随机 loopback 端口
启动并关闭 HTTP server。构建步骤把 HTML/CSS/JS 放入 server tarball，smoke 从安装包读取这些资产并核对 MIME。
该测试没有源码 alias，不连接 Provider、真实 Browser 或用户 home；它证明当前两个开发包可安装并完成 Web 资产与
最小服务启停，不代表 npm tarball 自带 operator Cloak binary；包内运行不依赖 Python bridge runtime。

2026-09-10 按项目 owner 决定，后续全量验收只运行 `pnpm full`，不再默认运行 Python Quick、Full 或全量 unittest。既有 Python 测试保留为历史维护入口；仅在用户明确要求时执行。CI 同步采用 TS Quick/Full，具体触发见 HARNESS。

## 当前边界

Browser 静态样本运行 `pnpm preview:browser`，在 `http://127.0.0.1:4173` 查看。web project 已进入根
TypeScript project references 和现有 TS 检查范围；没有新增第三方依赖。样本服务器仅提供白名单静态资产，
不启动生产 Application 或 Browser Host；所有获取和发布都是内存演示。功能、直接测试和构建说明见
[`apps/web/README.md`](../../apps/web/README.md)。实时入口使用
`SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench`，在
`http://127.0.0.1:4174` 运行真实 Browser Host、SSE/JPEG、Candidate 和临时文献库；两者职责不同。

contracts package 只依赖 Web 标准 `TextEncoder`、`TextDecoder`、Web Crypto 和 base64 API；它不调用 Python
RPC、不连接真实 Provider、不读取用户 home、Catalog、Profile 或凭据。v1 fixture 位于
`tests/fixtures/compat-v1/`，只包含固定的 synthetic 数据，用于检查 Model、canonical bytes 和 hash。

2026-09-10 文档核对：早期 [运行时盘点](../../migration/evidence/baseline/runtime-capabilities.md) 是历史快照，
其中“Chromium 未安装、TS SQLite binding 尚未选择”已不反映后续实现进展。
[Browser Host 记录](../../migration/evidence/browser-acquisition/browser-host.md) 记载 2026-09-09 使用
Chrome for Testing 148.0.7778.96 完成临时 Profile 的 loopback 启动测试；
[SQLite 记录](../../migration/evidence/runtime/sqlite-compatibility.md)记载 worker 已采用 `node:sqlite` 并验证 v1 兼容行为。
后续最终 TS Full 已显式设置并实际运行 operator Cloak bundle，完整 source-checkout 工作台与安装包资产 smoke 均通过；
支持组合见[最终矩阵](../../migration/evidence/final/support-matrix.md)。这些结果仍不构成生产切换或独立安装包自带
Browser runtime 的承诺。
qpdf 仍只有早期“未安装”记录，按 PDF 验收需要核实，不把历史环境记录当成永久前置门。

Candidate/receipt 已增加显式 SQLite execution extension；合成副本上的新进程恢复、发布对账、升级备份和回滚
见 [恢复证据](../../migration/evidence/runtime/candidate-recovery.md)。目标 Cloak 的本地工作台与 PDF intake
见 [运行时旅程](../../migration/evidence/browser-acquisition/cloak-workbench-runtime.md)，实际 MinerU/Analysis/Library
闭环见[联合旅程](../../migration/evidence/runtime/browser-mineru-analysis-journey.md)。这些切片不表示生产切换完成。

## 恢复入口

跨会话继续时先读取活动计划 README、对应阶段任务行的状态与证据、`git status --short` 及源码/直接测试。
活动计划的 `full-migration-roadmap.md` 是原始 M0–M6、T001–T064 的唯一任务状态源；阶段文档只保留实施说明和证据。旧 Block/Task 台账已归档，不用于推断当前完成度。合同切片的
直接证据位于 `migration/evidence/contracts/`；早期运行时盘点位于 `migration/evidence/baseline/`，后续切片记录位于
`migration/evidence/runtime/` 和 `migration/evidence/browser-acquisition/`。发现 v1 bytes、
hash、ID 或错误边界差异时，回到 contracts package 的行为测试和 synthetic fixture，保留失败样本并禁止修改
既有 golden 来消除差异。

配置边界的直接行为测试位于 `apps/server/test/configuration-boundary.test.ts`。它只使用注入的临时 home，验证
空配置默认值、严格 TOML section/key、Provider/Model 引用、Parser/Browser 约束、Browser policy 收紧、预算、
权限、符号链接和描述符读取期间的文件替换；它不会读取当前用户的 home、凭据、Catalog 或 Profile。

凭据边界的直接行为测试位于 `apps/server/test/credential-origin.test.ts`。文献 Provider、Model Provider 和
Core/MinerU secret 使用分离的 namespace；Model/Core 的 `CredentialGrant` 绑定 bundle、provider、field、
精确 origin、operation 和 expiry，文献 Provider 使用独立的 `provider-request` grant。预览不包含 secret，
测试只使用注入的临时 home。

### 配置、凭据与运行依赖

`TypeScriptConfigurationOwner`、`TypeScript` Credential Broker 和 `ConfigurationReadiness` 是当前唯一生产 owner。TS Full 使用临时 home，验证 TOML parser、revision/CAS、credential keep/set/remove、exact-origin grant、脱敏 readiness 和 Application 重启；不读取个人配置、Catalog、Profile 或凭据。历史 Python 配置测试和 80×24 PTY 过程材料仅作离线 oracle，不属于 TS 发布包或默认运行路径。

`configuration-typescript-owner.test.ts`、`configuration-boundary.test.ts`、`configuration-probe-journey.test.ts` 和 `cli-main.test.ts` 覆盖非 TTY command、取消、退出码和无网络 status。显式 test 只连接 synthetic/loopback fixture；status 永不自动联网。

PDF 内容验证及 catalog 写入准入需要 `prlimit`、`flock`、`pdfinfo` 和 `pdftotext`（Linux 的 util-linux/poppler-utils）。目标 Cloak/实时
工作台测试通过 `SCIRETRIEVER_CLOAK_BUNDLE` 显式选择已校验 bundle；无该变量时其目标 runtime 用例报告
skipped，不得据此声称目标 Cloak 已验收。参见[运行依赖证据](../../migration/evidence/baseline/runtime-dependencies.md)。

Parsing、MinerU 和 Analysis 均由 TypeScript 生产实现；`parsing-artifact-rules.test.ts`、`mineru-parser.test.ts`、`analysis-service.test.ts` 只使用 synthetic input 与 fake transport，验证资源闭包、取消、协议和两阶段输出，不启动 Python。

`model-loopback.test.ts` 通过临时配置和本地 HTTP 服务验证三种模型 adapter 的实际网络组装；Analysis
另有从正式 ParserResult 经两次实际 loopback 模型 HTTP 到 Literature 接纳的组合测试。loopback 模型
使用无凭据 HTTP，配置明确端口；旧 provider 凭据必须由 owner 显式移除后才可组装本地端点。
