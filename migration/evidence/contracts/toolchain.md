# TOOLCHAIN-CONTRACT 证据

## 2026-09-12 当前状态

当前 TS Full 已复验通过：119 个测试文件中 3 个跳过，466 个用例通过、4 个跳过；Prettier、ESLint、源码与测试
strict typecheck、contracts/server/web build 和离线安装包 smoke 均通过。`SCIRETRIEVER_CLOAK_BUNDLE` 未设置，
依赖 operator-managed Cloak bundle 的测试保持准确 skip。后续验收不运行 Python Quick/Full/unittest。

## 2026-09-10 历史状态

当时工具链已扩展到 contracts、server、web 三个 project 和安装包 Web 静态资产构建。该次
`SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> pnpm full` 通过 85 个测试文件、352 项测试，包含 Quick、全部
Vitest、目标 Cloak、tarball smoke 与 build；日志为 `/tmp/sciretriever-plan-full-final.log`。下文保留 2026-09-09
各切片的原始数量和当时未完成范围，用于追溯，不代表当前计划状态。依据项目 owner 后续决定，最终验收没有
再运行 Python Quick/Full/unittest。

## 2026-09-09 补缺与重新验收

本次修复三个可复现问题：测试未纳入 strict typecheck；server 声明的 `dist/index.js` 没有源码入口；
锁文件遗漏 server → contracts 的 workspace 关联，导致冻结安装和 server 打包失败。

实现及验证范围：

- `tsconfig.tests.json` 纳入当前六个 TS 测试文件，`typecheck` 同时检查源码 project 和测试。
  新检查发现 `contract-validation.test.ts` 将 unknown 数组当作对象展开，已改为明确的非法 author 输入，保留拒绝断言。
- server 的公开入口导出已有普通配置边界；凭据签发与私有实现不从根入口导出。两个包只打包 `dist` 中的 JS/声明。
- tsbuildinfo 进入各包 ignored `dist/`；锁文件只新增本地 workspace 关联，第三方版本及 resolution 未变化。
- `package-entrypoints.test.ts` 打包真实 contracts/server，在系统临时目录、独立 store/cache 离线安装，使用 Node
  的包解析执行 canonical/hash 与配置边界，检查未知配置和非公开子路径拒绝、包内无 src/test/tsbuildinfo。
  未发布的内部依赖通过临时 fixture override 绑定到本次 tarball，并核对包中实际依赖版本；不模拟远程 registry。

环境：Linux x86_64；Node `22.19.0`；pnpm `10.32.1`；Python `3.12.10`；baseline
`e1a33d5986f654f2692d7619dd58448944ec3463`。工作树包含此前未提交的迁移工作，本次未 commit/push 或回退这些内容。

| 命令或验证 | 实际结果 |
| --- | --- |
| `pnpm install --offline --frozen-lockfile --config.userconfig=/dev/null --config.globalconfig=/dev/null`（修复前） | 失败，`ERR_PNPM_OUTDATED_LOCKFILE`，缺 server importer |
| `pnpm install --offline --lockfile-only --no-frozen-lockfile --config.userconfig=/dev/null --config.globalconfig=/dev/null` | 退出 0；仅生成六行 workspace 关联，无第三方升级 |
| 再运行上述 frozen install | 退出 0，无下载；pnpm 提示忽略已有 esbuild install script，实际构建和测试随后通过 |
| `pnpm exec vitest run packages/contracts/test/package-entrypoints.test.ts packages/contracts/test/contract-validation.test.ts` | 2 files / 6 tests，退出 0 |
| `pnpm exec tsc -p tsconfig.tests.json --listFilesOnly` | 当前 6 个测试文件全部进入检查，无遗漏 |
| 复制实际 source/test tsconfig 到临时 fixture，分别加入 `export const value: string = undefined`，用 `pnpm exec tsc -p <fixture-config> --pretty false` 检查 | source/test 均以非零退出并报告 TS2322；未向仓库放入故意失败文件或类型抑制 |
| `pnpm exec vitest run <不存在的临时测试文件> --passWithNoTests=false` | 退出 1，No test files found |
| `pnpm full` | 退出 0；Prettier、ESLint、源码/测试 strict typecheck、6 files / 25 tests 与 build 通过 |
| `uv run --frozen python scripts/harness.py full` | 退出 0；2218 tests，3 skipped；Quick、Pyright、wheel 构建及内容核对通过 |

Python 的 3 个跳过项来自未设置真实已安装 CloakBrowser QA home 的验收类；没有启用真实 Profile 或浏览器探测。
完整终端日志在系统临时目录 `/tmp/sciretriever-toolchain-validation-n9l5j1_i/`，不是后续执行的必要输入。

| 文件 | SHA-256 |
| --- | --- |
| `package.json` | `1827e3fb736e4f98df99a189118ff5f42d3747d61b5d7723e9af6f7ca273ea76` |
| `pnpm-lock.yaml` | `e6789b653c8ce1535fb0d5943767b67480a7038c9fa328f41305b61d7a5a9ef1` |
| `tsconfig.tests.json` | `618e8d8174cd5c21495016976e19d7c6668461c48f5448945070371a76e58eda` |
| `apps/server/src/index.ts` | `9a19f011166a5bd84f0c0189843f8afed90d888e77730233b3c99a177438d964` |
| `packages/contracts/test/package-entrypoints.test.ts` | `929f16350b6043ec46b136050a8fc17f07291108d93d331ccf0eb4a2320ff690` |

R2：源码、直接正反例、公开入口、实际打包依赖和当前验证文档闭合；`TOOLCHAIN-CONTRACT` 恢复 Completed。
这仅证明当前两个开发包的工具链，Browser/SQLite/业务/最终安装旅程仍未完成；配置与凭据的补充语义验收仍开放。
下一恢复点为 `MIGRATION-CONTRACTS`，随后 Block 01 R3 与配置/凭据复核。

## 初次记录（历史范围）

## 2026-09-09 当前工作树复验

`pnpm full` 退出 0：Prettier、ESLint、源码与测试 strict typecheck、34 个 test files / 121 个 tests 和两个 workspace build 均通过。此次复验包含 provider adapter 状态机、配置驱动 application assembly、SQLite reopen 和启动失败清理测试。

日期：2026-09-09

已建立根 workspace、`@sciretriever/contracts` package、strict TypeScript project references、Prettier、ESLint、
Vitest 和 package build 入口；版本由 `package.json` 与 `pnpm-lock.yaml` 固定。lint 只扫描 `packages/**/*.ts` 和
`apps/**/*.ts`，不会扫描 Python、`.venv`、依赖或构建 staging。

可重放命令及结果：

```text
pnpm install --no-frozen-lockfile       # 生成初始锁文件，退出码 0
pnpm quick                              # format、lint、typecheck，退出码 0
pnpm test                               # 3 files / 10 tests passed，退出码 0
pnpm full                               # quick、test、contracts build，退出码 0
```

初次运行发现 `eslint .` 会扫描 `.venv` 和已有构建/依赖 JavaScript，已将 lint 范围修正为活动 TypeScript 源文件，
没有通过降低规则或忽略 TypeScript 文件解决。未引入 Python RPC、真实外部服务或生产数据。
