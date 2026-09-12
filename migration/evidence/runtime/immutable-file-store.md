# FILE-STAGING 执行与审查记录

状态：`Completed`。本文件记录 staging 三个行为切片的汇合验收。

## 已有实现与测试

staging.ts 已完成 bounded write/read、handoff/discard；immutable-file-store.test.ts 与 file-staging-lifecycle.test.ts 共 7 项通过。

## 验收结果

| 边界 | finding 与关闭条件 |
| --- | --- |
| 目录替换 | 目录 descriptor 和目录项 identity 不一致时拒绝；目录替换后自有 stage 被清理且新目录不被误删。 |
| no-follow | staging 目录 symlink、目录项替换和 hardlink 均 fail closed。 |
| 并发与 seal | concurrent writes 串行化；handoff 后 write 被拒绝；discard/close 只处理自身对象。 |
| hash/limits | 读取内容按字节上限处理，describe 返回 SHA-256 和相对引用。 |
| 平台 | Linux 使用 descriptor binding；其它平台的 fallback 受 runtime support matrix 约束，未宣称跨平台等价。 |

## 恢复与范围

当前串行恢复点为 `FILE-PUBLICATION`，以活动计划根 README 和对应 Task 为准。
测试只使用 fake DNS、合成字节、loopback 和系统临时目录；未读取真实凭据/用户数据或访问真实外部服务。
