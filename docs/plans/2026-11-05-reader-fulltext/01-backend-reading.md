# 01 · 后端：公式、批次与图片

类型：计划（结果块）
负责：整理稿的公式输出、文档读取批次与图片读取
状态：Done

## Outcome

- 公式叶块有 LaTeX 时，整理稿只输出 `$$…$$`，不再同时输出截图；LaTeX 为空时保留截图。用新的生成版本号，旧版本按原样重现。
- 全文读取每批不再只返回 32 段，请求数明显减少。
- 阅读器取一张图片只需一次请求。

## 背景

`apps/server/src/archive/render.ts` 对带图的叶块先写 `![](…)`，再给公式包 `$$`，公式类型没有排除；真实论文 378 个公式全部重复。生成版本按记录的 builder 逐字节重现，所以不能直接改 `source-order-leaves-v3`。

## 责任边界

Codex：`apps/server/`、`packages/contracts/`、对应测试与技术文档。不改 `apps/web/`。

## Tasks

- [x] **1.1 公式**：新 builder（如 `source-order-leaves-v4`），v3 与更早版本原样保留并能重现。
- [x] **1.2 批次**：放宽每批段数上限，仍受字节预算约束。
- [x] **1.3 图片**：图片一次取回的读取方式，保留现有校验。
- [x] **1.4 合同与文档**：回执 `contract.md`；技术文档同步。

## 验证

直接测试：v4 公式只出 LaTeX、空 LaTeX 保留截图、v3 重现不变、批次上限、图片读取。

## 退出条件

回执 `DONE.md` 给出提交、合同与验证结果。

2026-11-05 已满足：`69b71d9`（`source-order-leaves-v4`、slice 每批 200 段、`document-resource-bytes` 整图读取），回执 `sandbox/reports/2026-11-05-plan19-01/`。联调时发现带结构标注的 segments 第二页必定 400（cursor 把 segments 的 selector 交给 slice 的解析，自 `dd9d2bf` 起存在，长文档读到约 200 段就停），`3d2778c` 修复，回执 `sandbox/reports/2026-11-05-plan19-01b/`。
