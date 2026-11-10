# 11 · 验收、文档与交接

类型：计划（结果块）
负责：计划 16 的全量验证、文档同步、成套效果评估与部署
状态：Pending

## Outcome

1. Full 通过，或失败已修复并按 HARNESS 5.4 与第 6 节记录；
2. G-adr 通过后，规格第 8 节草案并入正文并删除草案节；指南与实现一致；
3. 若获 G-real 授权，有成套效果评估：用 Owner 指定的一批真实文献把全部命名组合跑通，记录质量、成本与可用性；未获授权时计划标为“工程完成、效果待验”；
4. 若获 G-deploy 授权，4174 部署并完成只读冒烟。

## 进入条件

01–10 退出，或 Owner 决定的子集已退出并在根 README 进度中记录范围。

## 责任边界

worker：Full、部署、G-real 执行；Claude：文档并入、指南、效果评估方案与结论、审阅与验收。

## Tasks

- [ ] **11.1 Full**〔worker〕：`VITEST_MAX_FORKS=36 VITEST_MIN_FORKS=12 pnpm full`；失败修复后先定向复验，只在新改动或未解决风险要求时扩大验证；不以定向结果拼接冒充 Full。
- [ ] **11.2 规格并入**〔Claude〕：G-adr 通过后，把[知识加工规格](../../architecture/technical/05-knowledge-processing.md)第 8 节中已实现的部分并入第 2、6、7 节并删除草案节，未实现的部分留在草案并写明；被部分取代的 ADR 只更新状态行；同步[设计](../../architecture/design.md)与[知识服务工作流](../../architecture/knowledge-service-workflows.md)中需要改的一句话链接。
- [ ] **11.3 指南**〔Claude〕：更新[统一加工指南](../../guides/knowledge-processors.md)、[Agent 接口指南](../../guides/agent-interface.md)、[Web 指南](../../guides/web-workbench.md)，只写已实现行为；按[文档影响映射](../../development/documentation-map.md)补齐其它受影响文档。
- [ ] **11.4 成套效果评估**〔Claude 写方案，worker 执行，须 G-real 授权〕
  - 环境：从正式库复制出的可写隔离库，配独立的知识存储目录；不写正式库。
  - 范围：Owner 指定的文献范围与预算，依次跑通 `question-synthesis`、`record-comparison`、`publication-statistics`、`topic-wiki`、`entity-graph`。
  - 基准：在 B0 基准上重跑问答与记录比较，与 E1 的结果和期望答案对照，说明改进或退化。
  - 对照：旧版本（`summary@2`、`labels@2`、`knowledge-synthesis@2`）经隔离旧执行入口或已有历史结果对照；旧入口已删除时只用历史结果。
  - 人工核查口径（Claude 在方案中写明，Owner 确认）：每个组合抽样的条目数与抽样方式；逐条判断引用是否支持陈述、数值是否与原文一致、未定项是否合理、实体合并与边是否成立；记录用量与估算偏差、完成度。
  - 结论只陈述所评估的样本。
- [ ] **11.5 G-deploy**〔worker，须授权〕：构建、重启 4174、只读冒烟；有表结构变化时另按 G-schema 流程。
- [ ] **11.6 计划收尾**〔Claude〕：更新根 README 状态、残余风险与最终 revision，归档。

## 验证

- Full 原始日志位置与结果写进交接记录；
- 文档：链接、术语、命令事实、Markdown 结构与 diff 检查；
- G-real 的结论只陈述观察到的样本，不推广为全库质量。

## 退出条件

计划级完成标准全部满足（见根 README）。

## 恢复与交接

Full 失败时按失败归属退回对应块，修复后先定向复验；效果评估发现问题时记录并交 Claude 判断退回哪一块修正，不在本块直接改算子行为。
