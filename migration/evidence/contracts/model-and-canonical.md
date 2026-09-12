# Block 01 合同证据

日期：2026-09-09

基线 revision：`master@e1a33d5986f654f2692d7619dd58448944ec3463`

## 生产结果

`packages/contracts/src/index.ts` 提供 provider-neutral 的 v1 Model 边界：canonical UUID/SHA-256/相对 POSIX
路径、枚举、nominal ID、Provenance、metadata、Literature identity、Reference、Asset、LibraryQuery 和
稳定脱敏错误。所有解析器拒绝未知字段、错误的 `null`、非法枚举、越界整数、坏日期、自引用关系、坏 ORCID
以及不安全路径；返回对象和集合被冻结。

canonical 层递归排序 key、规范化 Unicode NFC、拒绝 surrogate 和非有限数字，严格解析 UTF-8 JSON 并拒绝
duplicate key；canonical bytes 与 synthetic v1 fixture 的 SHA-256 一致。cursor 使用 kind/version/payload
绑定、checksum 和无填充 base64url，错误 kind、版本和篡改内容都会拒绝。

## 可重放验证

```text
pnpm full
```

结果：退出码 0；Prettier、ESLint、TypeScript strict project-reference typecheck、Vitest（3 个文件、11 个
测试）和 contracts build 全部通过。

```text
uv run --frozen python scripts/harness.py full
```

结果：退出码 0；Python Quick、Pyright strict、全量 unittest、wheel 构建和 wheel 内容核对全部通过。

直接测试覆盖：synthetic v1 provenance/metadata/query/asset/literature/reference 解析、未知字段、错误 null、
跨字段错误、脱敏错误、Unicode/嵌套 key 排序、duplicate key、无效 UTF-8、非有限数字、SHA-256、cursor 绑定
和测试文件行为命名门禁。测试文件为 `contract-validation.test.ts`、`canonical-encoding.test.ts` 和
`toolchain-contract.test.ts`，没有使用阶段编号或任务编号命名。

产物 hash：

```text
pnpm-lock.yaml                                      ad4f664b948e36c185759832849be67cfe3e2b0f8b9e3b8c16a063d4f2a0ea67
packages/contracts/src/index.ts                     78c786102efd10a8024d92b0eefdb5b746fa0b90b4a3f7d089e5bcb6ff841058
packages/contracts/test/contract-validation.test.ts 2da5f4a1499c3487ab3e1ede8426728892dfbebf6cb715822918b12102cc4852
packages/contracts/test/canonical-encoding.test.ts  6442c70d6485e2daa48d068086dcf8c198091e8746b5c95b60e94a5290477752
```

## 边界与恢复

输入范围只有仓库内 synthetic fixture 和固定负例；没有访问真实 Catalog、用户文件、凭据、Provider、LLM、
MinerU、出版社或外部网络。Chromium 未安装、TS SQLite binding 未选择仍是后续块的进入门事实，不被本证据
解释为已验证能力。合同或 fixture 出现差异时，从 `MODEL-IDENTITY`、`MODEL-RECORDS`、`MODEL-ERRORS`、
`CANONICAL-JSON` 或 `CANONICAL-INTEGRITY` 的直接测试恢复，禁止修改旧 golden 消除差异。
