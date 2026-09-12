# TypeScript Configuration/Credential Owner

日期：2026-09-11。

`apps/server/src/configuration/owner.ts` 现在直接拥有普通配置和凭据编辑合同。它读取现有 TS TOML parser 的严格 schema，使用固定 home、owner-only 文件和 `configuration` 文件锁；普通配置发布和凭据发布都采用临时文件、写入/文件同步后原子替换，不通过 Python 子进程。

凭据编辑覆盖 `model`、`source` 和 `mineru` 三个命名空间的 `set`、`keep`、`remove`。空的 set 输入保留已有秘密，readiness、错误和返回 DTO 只有 presence/origin 状态；模型和 MinerU 秘密绑定到配置中的 HTTPS origin，配置 revision 变化会拒绝编辑。旧的 Python owner bridge 仅在历史兼容测试材料中保留，不进入 TS 生产路径。

直接证据：

- `apps/server/test/configuration-typescript-owner.test.ts` 的配置读写、revision 冲突、origin-bound model/MinerU、source 字段合并、空 set 保留和秘密不回显测试；
- `pnpm exec vitest run apps/server/test/configuration-typescript-owner.test.ts`：3 tests passed；
- `pnpm typecheck`：源码和测试 strict 类型检查通过。
