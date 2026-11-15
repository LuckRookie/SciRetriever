# Skills

类型：代码导航
负责：文献库自带、给桌面 Agent 用的 skill
状态：现行

| 目录                                   | 内容                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| [sciretriever/](sciretriever/SKILL.md) | 连接文献库、代使用者入库（Zotero 由扩展导入）、经 HTTP 版 MCP 使用文献库、失败与恢复 |

skill 只讲怎样使用和工作流程，接口以文献库在 `GET /api/v1/import/instructions` 给出的说明为准（[ADR 0019](../docs/architecture/decisions/0019-agent-operable-application-and-sdk-model-runtime.md)、[ADR 0058](../docs/architecture/decisions/0058-import-system-and-agent-access.md)）。根目录 `pnpm build` 运行 [`scripts/build-agent-access.mjs`](../scripts/build-agent-access.mjs)，把它打成 `apps/server/dist/agent-access/skill.zip` 和合并的 `instructions.md`，设备连接在 `GET /api/v1/device-connections/skill` 与 `/instructions` 下载。

[项目目录地图](../README.md#项目目录地图)
