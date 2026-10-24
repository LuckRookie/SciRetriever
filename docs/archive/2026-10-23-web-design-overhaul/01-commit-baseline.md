# 01 · 分组提交与干净基线

类型：计划（结果块）
负责：分组提交与干净基线
状态：Done

## Outcome

上两轮（计划 13 第一、二轮）及 2026-10-23 的性能、入库回执、原型退役与计划归档改动，按主题分组提交到本地 `master`，不 push。之后工作区只剩本计划自己的改动，每个审阅点的 diff 可以单独看、单独回退。

## 进入条件

- G0：Owner 明确授权本次分组提交。提示词由 Owner 转交或 Owner 在会话中回复授权，均视为授权。
- 上一计划的分组草案：`sandbox/reports/2026-10-22-web-round2-release/commit-groups-final.json`。10-22 之后又有改动，逐文件 hash 已失效，必须重算。

## 责任边界

worker 执行。只做 Git 暂存与提交，不改源码内容。发现某文件归属不清，单列出来交 Claude，不自行猜测。

## Tasks

- [x] **1.1 重算分组清单**
  - 以 `git status --porcelain` 为准，列出全部条目；按主题分组：第一轮审查服务、第二轮后端与契约、第二轮 Web、10-23 性能、10-23 入库回执与真实闭环、文档与计划归档（含 `.gitignore`、原型退役）。
  - 每组写提交信息草稿（英文，Conventional Commits）、文件清单与逐文件 SHA-256；输出到 `sandbox/reports/2026-10-23-plan14-commit/groups.json`。
  - 列出不应提交的条目（生成物、本机路径、凭据样式内容），给出理由。
  - 完成证据（2026-10-23）：清单基准 `68d80c3`，324 个路径归六组，逐文件 hash 与完整 porcelain 核对一致；收口 revision `885e9e1`。
- [x] **1.2 交 Owner 确认**：Claude 核对清单后转交 Owner。未确认前不暂存。
  - 完成证据（2026-10-23）：Owner 明确授权 G1–G5 合并为代码基线、G6 为文档两个本地提交，不 push；D1–D3 按提交派活单执行，收口 revision `885e9e1`。
- [x] **1.3 提交**：按确认后的清单逐组 `git add <files>` 与 `git commit`；每组提交前核对 hash 与清单一致；提交信息末尾带 `Co-Authored-By` 行（按会话当时的署名要求）。不 push，不改写已有历史。
  - 完成证据（2026-10-23）：`94a15e6ec7351aa607faef18d81e2fa9f20873cd` 代码基线 229 个路径；`885e9e12560507e17a5c5c828e49fae5dd520810` 文档 95 个路径条目（Git 合并识别 15 个重命名后统计为 80 个文件）。均逐文件暂存并核验暂存及提交字节，带指定 Claude Co-Authored-By。
- [x] **1.4 提交后核对**：`git status` 只剩清单中明确不提交的条目；`pnpm quick` 通过（只证明提交后的树仍能通过机械检查，不代替 Full）。
  - 完成证据（2026-10-23）：revision `885e9e1` 提交后工作区干净，唯一一次 `pnpm quick` 退出 0；原始日志 `sandbox/reports/2026-10-23-plan14-commit/quick-commit.log`。之后仅按授权补本文件与根 README 的交接，留在工作区不提交。未运行 Full、未 push、未操作正式库或 4174。

## 集成与影响

只影响 Git 历史。4174 运行的构建不变。

## 验证

- `git log --stat` 每组文件与清单一致；
- `git status --porcelain` 结果写入交接记录；
- `pnpm quick` 原样记录结果。

## 退出条件

工作区干净（除清单列明的例外）；后续块的 diff 只含本计划改动。

## 恢复与交接

提交中途失败：停在失败的那一组，不回滚已完成的提交，把 `git status` 与错误原文写进交接记录交 Claude。未获 G0 时，本块和依赖它的块都不开始。
