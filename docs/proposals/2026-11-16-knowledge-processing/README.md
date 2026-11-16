+++
document_type = "proposal"
status = "draft"
created = "2026-11-16"
+++

# 知识加工

类型：提案
负责：知识加工的全部计划内容（平台、预置算子、研究任务、阅读层与阅读页上的加工视图）
状态：暂缓（Owner 2026-11-14：“加工我们之后再考虑”；2026-11-16：所有关于知识加工的计划内容汇总到一个提案，计划中不再出现）

## 这份提案是什么

Owner 2026-11-16 决定先把加工之前的部分做好（[计划 25](../../plans/2026-11-16-before-processing/README.md)），并把所有关于知识加工的计划内容收到这里。本目录不授权实施；重新开工时，由总设计师按当时的代码与规格把它改写成计划，经 Owner 同意后放进 `docs/plans/`。

决定与规格不在这里：它们仍在各自的归属文档中，是现行的目标规格（尚未实现）：

- 决定：[ADR 0044](../../architecture/decisions/0044-knowledge-processing-platform.md)（知识加工平台）、[ADR 0059](../../architecture/decisions/0059-general-literature-knowledge-base.md)（通用文献知识库）、[ADR 0060](../../architecture/decisions/0060-two-level-full-text.md) 第 4 节（加工读取初稿）、[ADR 0061](../../architecture/decisions/0061-reading-first-reader-and-layered-reading.md)（阅读层）。
- 规格：[知识加工](../../architecture/technical/05-knowledge-processing.md)第 8 节；[文档与证据](../../architecture/technical/04-document-evidence.md) 8.6；[阅读体验](../../architecture/web/reading-experience.md)中概览、脉络、按问题阅读、库内关联、证据与关键句的部分。

## 内容

| 部分                                                                                   | 文件                                                                                                                                                                                                                                                             | 原位置                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 加工平台与研究任务（原计划 16 的全部）                                                 | [00-plan-16.md](00-plan-16.md) 与 01–14                                                                                                                                                                                                                          | `docs/plans/2026-10-24-operator-plugins/`                                                          |
| 阅读页第三次交付：读取层、概览与脉络、按问题阅读、库内关联、长资料、验收               | [reader-13](reader-13-processing-data.md)、[reader-14](reader-14-overview-and-key-points.md)、[reader-15](reader-15-ask-lens.md)、[reader-16](reader-16-library-relations.md)、[reader-17](reader-17-long-material.md)、[reader-18](reader-18-third-delivery.md) | 原计划 24 的 13–18                                                                                 |
| 初稿的加工读取、找不到的引用、两种加工结果的评估；阅读页第二次交付中依赖加工结果的部分 | [deferred-items.md](deferred-items.md)                                                                                                                                                                                                                           | 原计划 21 的 7.7、9.1、11.4、G5；原计划 24 的 9.2、9.4、10.3、10.4、11.5、11.7、11.10 中的加工部分 |

这些文件原样移来，内部的块号、任务号和互相引用保持原计划的写法，不重新编号；指向已归档计划的链接改到 `docs/archive/`。

## 阅读页第三次交付与加工的对应

原计划 24 的第三次交付在设计样例库的合成结果上实现和验收；显示真实结果要等原计划 16 的这些 Task：

| 阅读页块             | 显示真实结果要等的计划 16 Task                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reader-13 读取层     | 14 的 14.9：知识加工 8.12 的十个读取操作（含 `material-evidence` 及其存储投影、`material-progress`）与 8.13 的能力报告（`material-reading`、`processing_capabilities`），以及它们的合同 |
| reader-14 概览与脉络 | `material-layers`、`material-points`、`material-marks`（14.9）；结果来自 14.1–14.4，推出内容来自 14.8；发起加工要 14.7 与 02 的 2.5、2.9                                                |
| reader-15 按问题阅读 | `material-answers`、`material-answer`、`material-progress`、带 `answer_result_id` 的 `material-marks`（14.9）；回答来自 02 的 2.1，提问经 2.5、2.9；有关的要点来自 14.8                 |
| reader-16 库内关联   | `material-relations`、`material-topics`（14.9）；`citations` 随 14.9 就有；按要点的关系来自 10 的 10.5a、10.6；所在主题页来自 12 的 12.5、12.7                                          |
| reader-17 长资料     | `material-chapters`，以及带 `chapter_id` 的 `material-layers`、`material-points`、`material-marks`（14.9）；按章的判定与结果来自 14.5                                                   |

- 计划 16 的 14.11 做结果页里的概览视图与脉络视图。两边共用 reader-13 的读取层与类型，不各写一份。
- 审阅点 R3：合成结果上的概览、脉络、回答、关联、按章视图截图；有真实结果时另附（须计划 16 的 G-real 与正式库副本的授权）。

## 已有的进展

- G-adr 已通过（2026-11-10，Owner 接受 ADR 0059、ADR 0060 与修订后的 ADR 0044）。
- 没有实现。初稿已经是正式文本（计划 21，2026-11-16 部署），但现行算子只读校订稿；7.7 与 9.1 是让加工读取初稿的两项。
- 计划 25 完成后，阅读页已经有新的版面（案头、纸页、右侧面板、书脊），第三次交付直接在它上面加视图。

## 重新开工之前

- 按当时的代码核对每一块的进入条件与触达的文件；原计划 16 的基准（B0）与效果检查点（E0、E1）仍然先做。
- 计划 25 的 23.8（E2）若已完成，E3 用同一批样本。
- 块号与任务号按新计划重新编排，在新计划里写明来源。

[上级目录](../README.md) · [项目 README](../../../README.md)
