# 02 · CLI 帮助补齐

类型：计划（结果块）
负责：CLI `--help` 列出已实现的 `folders` 与 `literature open` 命令
状态：Pending

## Outcome

`sciretriever --help` 列出 `folders list|delete-preview|create|rename|move|delete|add|remove` 与 `literature open ID`，写法与已列出的 `marks` 一行相同。命令本身的行为不变。

规格：[用户整理第 7 节](../../architecture/technical/09-user-organization.md#7-三个入口)的命令表。

## 进入条件

G1。不等 01。

## 责任边界

- 负责：后端实施者。
- 触达：`apps/server/src/cli/main.ts` 的帮助文字（现有 `marks` 一行约在第 194 行）。
- 不改：命令的解析与执行、其它命令的帮助。

## Tasks

- [ ] **2.1 帮助文字**：按规格第 7 节的命令表，在帮助里加上 `folders` 与 `literature open` 两行，各附一句说明。
- [ ] **2.2 测试**：在 `apps/server/test/cli-main.test.ts` 中断言帮助输出包含这两个命令。

## 集成与影响

只改帮助文字。

## 验证

- `cli-main.test.ts` 定向通过，并证明帮助里同时有 `folders`、`literature open` 与 `marks`。
- `pnpm quick`。

## 证据

提交号（G-commit 之后）；定向测试结果。

## 退出条件

帮助列出两个命令。01 的 1.5 可以删去规格第 7 节中“CLI 的 `--help` 当前没有列出”一句（或留到 08）。

## 恢复与交接

改动很小，中断时以测试为准重做即可。
