# CONFIG-PARSER 验收证据

## 结果

`@sciretriever/server` 已提供 ordinary configuration 的解析和固定 home 读取边界。空文档和只含部分
section 的文档使用当前 Python 产品默认值；Provider、Model、Analyze、Parser、Browser、Source、执行和
Library 字段在边界转换为冻结对象。解析器拒绝未知 root/nested key、重复 TOML key、dotted key 空段、错误
类型和 enum、孤立引用、非 image Browser Model、Parser URL/模式冲突、原始及编码 dot/path segment、无
Profile 的启用 Browser、空或放宽的 `browser-generic` policy override、预算越界和不安全 URL。

固定 home 读取只允许 `.sciretriever/config.toml`，校验 owner-only 目录和文件权限、普通文件、单硬链接、
`O_NOFOLLOW` 描述符及读取前后 inode/size/mtime 与目录项身份。缺少配置文件按空配置处理；符号链接和
描述符打开后目录项被替换均 fail closed。测试只使用系统临时目录，不读取当前用户 home、credentials、
Catalog、Profile 或外部服务。

## 直接验证

```text
pnpm quick                         PASS
pnpm test                          PASS (6 files, 30 tests; configuration suite 10 tests)
pnpm full                          PASS
uv run --frozen python scripts/harness.py full
                                    PASS
git diff --check                   PASS
```

`configuration-boundary.test.ts` 的 10 个行为用例覆盖默认值、部分 section、完整 provider/model 配置、
注释、dotted key、multiline array、inline table 尾逗号、未知/重复/坏值、原始及编码 URL path segment、
URL/Parser/Browser/policy/预算拒绝、注入 home 读取、符号链接、读取期间文件替换和有界输入拒绝。测试文件
和 suite 按行为命名，没有使用块、阶段或任务顺序名称。

实现文件 SHA-256（写证据时）：

```text
4a688ef0cc546b3ae1617668d55159631963a0d467d2ef7adaa97a96e9fba010  apps/server/src/configuration/index.ts
914780bec1bce0dc03993a2c1d4275ac69aeba34a5b2220e7830653af74fc1e1  apps/server/test/configuration-boundary.test.ts
62c2e1513db45a91a0ec1918c4287995cf046dc92f11fd6defbeead0da3533  package.json
a5d4934d644c7a8db5ee71c8bf077d25236aca3ccd58d1abbcc635f6622655bb  tsconfig.json
146b11026d46c1ecbff040aba8b473125c1a6d5d623f6e57277a0af5b49e4816  apps/server/tsconfig.json
```

## 审查结论与边界

根 `tsconfig.json` 已引用 server project，根 `build` 已改为 `tsc -b`，因此 Full 会构建当前两个 project。
本 Task 没有实现 credentials、Network、SQLite、Browser runtime 或业务组装；未运行真实 Provider、MinerU、
Browser、SQLite 或用户数据迁移。下一恢复点是 `NETWORK-ADMISSION`。
