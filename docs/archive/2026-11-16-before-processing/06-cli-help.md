# 06 · CLI 帮助补齐

类型：计划（结果块）
负责：CLI `--help` 列出已实现的 `folders` 与 `literature open` 命令
状态：Completed（2026-11-16）

来源：原计划 22 的 02（任务 2.1、2.2 改为 6.1、6.2）。

## Outcome

`sciretriever --help` 列出 `folders list|delete-preview|create|rename|move|delete|add|remove` 与 `literature open ID`，写法与已列出的 `marks` 一行相同。命令本身的行为不变。

规格：[用户整理第 7 节](../../architecture/technical/09-user-organization.md#7-三个入口)的命令表。

## 进入条件

无。

## 责任边界

- 负责：后端实施者。
- 触达：`apps/server/src/cli/main.ts` 的帮助文字（现有 `marks` 一行约在第 194 行）。
- 不改：命令的解析与执行、其它命令的帮助。

## Tasks

- [x] **6.1 帮助文字**：按规格第 7 节的命令表，在帮助里加上 `folders` 与 `literature open` 两行，各附一句说明。
- [x] **6.2 测试**：在 `apps/server/test/cli-main.test.ts` 中断言帮助输出包含这两个命令。

## 集成与影响

只改帮助文字。

## 验证

- `cli-main.test.ts` 定向通过，并证明帮助里同时有 `folders`、`literature open` 与 `marks`。
- `pnpm quick`。

## 证据

2026-11-16，后端实施者实现，总设计师审查、复跑 `cli-main.test.ts` 13 项通过后提交。证据在 `sandbox/reports/2026-11-16-plan25-06/`。

## 退出条件

帮助列出两个命令。收尾（24 的 24.1）删去规格第 7 节中“CLI 的 `--help` 当前没有列出”一句。

## 恢复与交接

改动很小，中断时以测试为准重做即可。
