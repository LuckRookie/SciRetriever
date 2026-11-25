# TypeScript 基础开发入口

类型：开发
负责：源码开发、构建、便携包验证入口
状态：现行

当前工作区包含 contracts、server 与 React Web。源码映射见[TypeScript 基线](../architecture/typescript-baseline.md)，安装与支持环境见[安装指南](../guides/installation.md)。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm build
```

开发循环与最终验收的命令、并发和范围统一见 [HARNESS §5.4](../../HARNESS.md#54-typescript-开发验证)。构建元数据进入 ignored `dist/`，测试按行为命名，不按阶段或任务编号命名。

Web前端按[ADR 0036](../architecture/decisions/0036-react-web-frontend.md)采用React、React Aria、Motion、TanStack及自有CSS；Quick同时覆盖 `.ts` / `.tsx` 与测试strict类型。`pnpm --filter @sciretriever/web dev` 启动Vite热更新，`SCIRETRIEVER_WEB_API_ORIGIN` 指向已经正常启动并认证的loopback工作台。开发代理仍走同一登录与client grant；测试不增加免认证模式。生产资源、阅读worker和字体离线随包交付；精确版本、补丁及许可见[前端依赖说明](../notes/web-frontend-dependencies.md)。默认入口和旧代码清理的实施记录见[归档计划](../archive/2026-10-19-web-experience/README.md)。

本机真实/一次性测试使用 Git 忽略的 `sandbox/`；场景、运行材料和报告的约定见[测试目录说明](../../tests/README.md)。
`vitest.config.mjs` 在默认排除项之外排除 `sandbox/**`，`pnpm test/full` 及根目录直接调用 Vitest 均不收集其中的用例；
原有模块回归与共享合成 fixture 的发现范围保持不变。

`package-entrypoints.test.ts` 构建并打包 contracts/server，在系统临时目录使用独立临时 store/cache 离线安装真实 tarball。
两个尚未发布的包通过临时 fixture 的 pnpm override 绑定到本次 tarball，并核对包中实际依赖版本一致；不使用远程 registry。
MCP SDK 引入同名依赖的多版本后，便携包与安装测试按已安装的依赖边固定 tarball；
不再要求整个图只有一个同名版本。打包递归包含运行时 required peer，Optional peer 不变为必需；DSH 组件的精确版本与服务边界见[外部依赖说明](../notes/deepseek-harness.md)。根依赖提供离线 peer resolution，按父包版本的 overrides
保留各调用方实际使用的版本；安装回归直接核对 SDK 与 body-parser 各自的 `content-type` 版本。
安装测试的长构建使用异步子进程，避免阻塞 Vitest worker 的控制通道。
测试通过 Node 的包解析调用 contracts 与配置公开入口，并检查未知配置拒绝、非公开子路径拒绝和源码/测试/构建元数据
未进入安装包；随后在临时 home 创建真实 Application/SQLite/FileStore 和 WorkbenchSession，在随机 loopback 端口
启动并关闭 HTTP server。构建步骤把 HTML/CSS/JS 放入 server tarball，smoke 从安装包读取这些资产并核对 MIME。
该测试没有源码 alias，不连接 Provider、真实 Browser 或用户 home；它证明当前两个开发包可安装并完成 Web 资产与
最小服务启停，不代表 npm tarball 自带 operator Cloak binary；包内运行不依赖 Python bridge runtime。

SQLite worker 的活动业务实现是 `apps/server/src/storage/sqlite/worker-runtime.ts`。源码模式由 Node 22
的 type stripping 启动该 TypeScript 文件，build 与 portable 包使用 `worker-runtime.js`；portable
验证会从生成包实际执行 `literature search --json`，因此同时覆盖 worker 文件清单、ESM URL 与运行入口。

CI 与测试纪律统一遵循 [HARNESS](../../HARNESS.md)，不在开发入口复制历史验收命令。

## 当前边界

Browser 静态样本运行 `pnpm preview:browser`，在 `http://127.0.0.1:4173` 查看。web project 已进入根
TypeScript project references 和现有 TS 检查范围；当前使用上述React组件依赖。样本服务器仅提供白名单静态资产，
不启动生产 Application 或 Browser Host；所有获取和发布都是内存演示。功能、直接测试和构建说明见
[`apps/web/README.md`](../../apps/web/README.md)。实时入口使用
`SCIRETRIEVER_CLOAK_BUNDLE=/absolute/path/to/verified/cloak/bundle pnpm preview:workbench`，目标是启动
`http://127.0.0.1:4174` 的 Browser Host、SSE/JPEG、Candidate 和临时文献库；当前修复快照没有运行真实
Cloak 正路径，离线测试的 fake/stock loopback 与 host seam 只证明 wiring/边界，两者职责不同。

contracts package 使用 Web 标准 `TextEncoder`、`TextDecoder`、Web Crypto 和 base64 API；普通 HTTP 浏览器缺少 SubtleCrypto 时，SHA-256 使用固定 `@noble/hashes` 本地后备实现，输出合同不变，离线包同时包含该依赖。它不调用 Python
RPC、不连接真实 Provider、不读取用户 home、Catalog、Profile 或凭据。v1 fixture 位于
`tests/fixtures/compat-v1/`，只包含固定的 synthetic 数据，用于检查 Model、canonical bytes 和 hash。

历史运行时与迁移验收只作[历史材料](../archive/2026-09-28-typescript-knowledge-architecture-migration/README.md)查阅，不定义当前环境或当前 Full 的结果。

## 恢复入口

跨会话继续时先从[活动计划索引](../plans/README.md)读取当前计划 README、对应块的状态与证据、`git status --short` 及源码/直接测试。
已归档迁移计划的 `full-migration-roadmap.md` 保留原始 M0–M6、T001–T064 的历史任务状态；阶段文档只保留当时的实施说明和证据，不用于推断当前完成度。合同切片的
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

PDF 文件验证及 catalog 写入准入需要 `prlimit`、`flock`（Linux 的 util-linux）与随程序到位的 MuPDF；不再需要 `pdfinfo` 与 `pdftotext`（poppler-utils）。目标 Cloak/实时
工作台测试通过 `SCIRETRIEVER_CLOAK_BUNDLE` 显式选择已校验 bundle；无该变量时其目标 runtime 用例报告
skipped，不得据此声称目标 Cloak 已验收。参见[运行依赖证据](../../migration/evidence/baseline/runtime-dependencies.md)。

Parsing、MinerU 和 Analysis 均由 TypeScript 生产实现；`parsing-artifact-rules.test.ts`、`mineru-parser.test.ts`、`analysis-service.test.ts` 只使用 synthetic input 与 fake transport，验证资源闭包、取消、协议和两阶段输出，不启动 Python。

`model-loopback.test.ts` 通过临时配置和本地 HTTP 服务验证三种模型 adapter 的实际网络组装；Analysis
另有从正式 ParserResult 经两次实际 loopback 模型 HTTP 到 Literature 接纳的组合测试。loopback 模型
使用无凭据 HTTP，配置明确端口；旧 provider 凭据必须由 owner 显式移除后才可组装本地端点。

`pnpm build` 在 TypeScript 增量编译后执行 `scripts/prune-retired-runtime.mjs`，精确清理已退役解析模块的旧输出，再构建 Web/阅读资源。脚本只处理已知退役文件并拒绝符号链接，不改动文献资产或其它生成物；无需手工清空整个 dist。
