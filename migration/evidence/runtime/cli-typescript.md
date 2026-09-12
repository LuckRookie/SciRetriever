# TypeScript CLI 证据

更新时间：2026-09-12。

`apps/server/src/cli/main.ts` 通过单一 `createApplication` 组装执行命令，支持 discovery、complete、literature 查询/详情/引用、四格式 metadata import/export、PDF/content 导出、configuration probes、storage inspect/migrate/backup/restore-check、doctor 以及 durable jobs create/run。JSON 输出和退出码在命令边界统一处理，原输入文件只读。

直接证据：`apps/server/test/cli-main.test.ts`、`apps/server/test/doctor.test.ts`、`apps/server/test/portable-package.test.ts`。测试使用临时 home 和合成记录；不访问真实 Provider、凭据或用户 Catalog。`jobs run` 只接受受限 job id，并复用 `ExecutionTaskService`。
