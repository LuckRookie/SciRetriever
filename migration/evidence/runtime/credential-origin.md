# CONFIG-CREDENTIAL 验收证据

> 本文的命令表保留最初 credential 切片的历史验收。2026-09-10 最终验收已转为 TS Full；当前状态和后续
> owner 组装见文末“后续闭环与边界”及 [Python 配置 owner bridge](configuration-owner-bridge.md)。

`@sciretriever/server` 已形成 credentials 边界：固定 `credentials.toml` 使用当前用户所有的 owner-only 目录和文件、
目录 descriptor binding、no-follow descriptor、单硬链接和读取前后 inode/size/mtime/目录项复核。缺失文件或目录表示
没有凭据；非法 section/field、空值、非 HTTPS origin、原始及编码 dot/path segment、半成品或同 origin 的 transition
group、文件竞态均 fail closed。

文献 Provider、Model Provider 和 Core/MinerU 的 secret 分别保存在私有 namespace；Model/Core secret 只保存于由
WeakMap 持有的私有 bundle，文献 Provider 使用独立的 provider-request grant。`CredentialGrant` 是有生命周期的
opaque 对象，绑定 bundle 身份、namespace、provider、field、规范化 origin（适用时）、allowlisted operation 和
expiry；读取值必须同时通过这些边界检查。secret 保留去除边界空白后的原始 Unicode 码点，不做 NFC 改写。迁移
预览只返回字段存在、origin 和 transition 元数据，序列化 bundle 不包含 secret。没有访问真实 home、凭据、Provider、
MinerU 或其它外部服务。

## 直接验证

```text
pnpm quick                         PASS
pnpm test                          PASS (6 files, 30 tests)
pnpm full                          PASS
uv run --frozen python scripts/harness.py full
                                    PASS
git diff --check                   PASS
```

`credential-origin.test.ts` 的 8 个行为用例覆盖 secret-free preview、Model/Core/provider 三类消费、同名
Provider namespace 隔离、Unicode secret 保留、bundle 绑定、exact-origin/operation/expiry、伪造 grant、完整
transition、坏 schema、owner-only 权限、注入临时 home 的 fixed path 和缺失凭据。测试不使用阶段或计划编号命名。

实现文件 SHA-256（写证据时）：

```text
4a688ef0cc546b3ae1617668d55159631963a0d467d2ef7adaa97a96e9fba010  apps/server/src/configuration/index.ts
7280f4adeada837ba7f7cc38a8d82f040047cd44587f43426691eb9a3afc49ea  apps/server/src/configuration/credentials.ts
914780bec1bce0dc03993a2c1d4275ac69aeba34a5b2220e7830653af74fc1e1  apps/server/test/configuration-boundary.test.ts
36ae726f2ee372516a8362b2666dae8d5af860f1a2e38d5712f651a5175be0ab  apps/server/test/credential-origin.test.ts
```

## 后续闭环与边界

本文件记录 credential origin 的基础切片。后续[Python 配置 owner bridge](configuration-owner-bridge.md)已完成
credential set/keep/remove、TUI 密码不回显、配置 origin 变更冲突和 Application 组装；Network admission 与
Browser/模型 transport 分别消费受限 grant。owner-only 非当前 uid 的正例没有在当前用户环境中伪造；目录/文件
mode、descriptor identity 和竞态已有合成临时目录测试，跨 uid 验证不在当前单平台支持声明内。
