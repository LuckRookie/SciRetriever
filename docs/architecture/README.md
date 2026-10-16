# 架构文档入口

## 阅读顺序与责任

1. [requirements](requirements.md)：科研Agent文献/知识目标，人类协作、调用方提取、查询与显式扩充分离，R1–R13验收。
2. [ADR索引](decisions/README.md)：0026/0027/0028决定产品方向；0031选定受控 DSH/Cordis 执行基础（方案已批准，接入中）；旧身份/来源/安全规则保留适用部分。
3. [principles](principles.md)、[design](design.md)：稳定不变量与目标模块/数据所有权。
4. [八模块技术导航](technical.md)：与 design 一一对应的 8 篇正文，分别给出内部结构、字段、接口、运行和存储设计。
5. [工作流](knowledge-service-workflows.md)、[统一产品接口：共享合同、结构解析与版本兼容](technical/01-product-interface.md#6-共享合同结构解析与版本兼容)：独立使用与组合时序、尚待冻结的字段和技术选择。
6. [TS基线](typescript-baseline.md)：当前实现和目标差距；[迁移映射](evolution-map.md)说明复用、替换、数据/API兼容与恢复，进度归[计划](../plans/README.md)。

目标、当前事实与Proposed细节分别标明。PDF获取重要但不统领其他模块；已有材料可独立加工；查询缺口不进入维护调度。模块化单体不等于所有操作都必须经过一条流水线。

## 历史和未决

[2026-09-28整理前快照](../archive/2026-09-28-pre-knowledge-docs/README.md)用于历史比较。仍有效的技术细节已恢复并修订在正式 technical 文档中，快照不代替当前技术正文。ADR本身留在本目录，保留决定背景与修订链，不因语言迁移批量撤销。

`sciretriever-service-architecture.archify.json` 是此前架构图源，尚未按最新读写边界重新验证；不把它作为本轮目标图或代码事实。当前流程以design/工作流为准，图源本轮保留未改动。

Web 整体方向见 [ADR 0032](decisions/0032-library-centered-web-workspace.md)，当前布局、视觉和交互依据见 [Web 界面设计](web/README.md)。后台存续、阅读器实现、长期回放、人类登录/MFA及具体新schema/保留/候选托管按契约提案逐项定稿。文档归档与计划不授权数据切换或发布。

## 子目录导航

- [technical/](technical/README.md)：模块技术正文。
- [web/](web/README.md)：当前有效的 Web 界面设计、定稿 HTML 与后续专项设计。

[上级目录](../README.md) · [项目 README](../../README.md)
