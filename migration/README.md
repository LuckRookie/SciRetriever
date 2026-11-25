# TypeScript 迁移兼容材料

保存 Python → TypeScript 迁移留下的基线、清单、兼容 oracle 与历史证据。部分 JSON 仍被当前回归测试使用。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [baseline/](baseline/README.md) | TypeScript 迁移基线 |
| [evidence/](evidence/README.md) | 历史迁移证据分类 |
| [spikes/](spikes/README.md) | 迁移技术探查快照 |

## 内容入口

- [inventory.json](inventory.json)：迁移盘点。
- [oracle-manifest.json](oracle-manifest.json)：合成兼容 oracle 的固定 hash。
- [intentional-changes.json](intentional-changes.json)：迁移中的明确行为差异。
- [retirement-report.json](retirement-report.json)：旧 Python 入口退役清单。

## 放置边界

这是兼容与历史材料，不是活动源码，也不是以后新增测试报告的地方；当前任务计划放 docs/plans，本机报告放 sandbox/reports。不要随意修改测试消费的 manifest。

相关说明：[当前基线回归](../apps/server/test/migration-baseline.test.ts)；[当前退役清单回归](../apps/server/test/python-retirement.test.ts)。

[项目目录地图](../docs/development/repository-map.md)
