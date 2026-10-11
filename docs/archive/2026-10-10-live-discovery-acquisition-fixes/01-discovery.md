# 发现结果可接纳

Outcome：主题年份约束有效；真实协议形状的 references/citations 能形成新 Literature、有向引用及来源支持；低预算和重复执行仍正确。

进入条件：真实报告中六项缺陷已复现。责任：Providers 解释外部协议，Metadata 转换并计数原始项，Entry 编排有界接纳，Literature 决定身份，Storage 保存确认事实。

- [x] 1.1 Crossref 规范化展示文本，不改动身份字符或弱化中性合同；增加换行/回车回归。
- [x] 1.2 Europe PMC 转换年份查询、按 ID 类型 lookup、按 references/citations 分页语义请求；合成 fixture 体现实测形状及不推进错误。
- [x] 1.3 Semantic Scholar 使用引用接口支持的字段；保留 references/citations 方向与原始计数。
- [x] 1.4 Metadata 提供逐项转换消费，Entry 先接纳关联目标内嵌 observation，需要时才 lookup；扫描/lookup 共享预算，取消和部分错误保留有效结果。
- [x] 1.5 验证非空引用重复执行、多来源支持、方向、深度与结果上限；必要时修复边发布重复问题，保持存储合同兼容。

集成影响：现有批量 Metadata API 和发现回执继续兼容，不修改数据库结构；新增内部逐项消费方式要复用同一协议与错误转换。

验证：相关 `metadata-crossref`、`metadata-europe-pmc`、`metadata-reference-adapters`、`discovery-topic`、`discovery-citation` Vitest；新增低预算内嵌/lookup、已有目标、重复边、两跳、错误与取消断言。03 再执行真实请求。

退出条件：预算内能实际接纳目标并查询来源关系，而不是只有零结果报告。恢复时保留未提交改动，先重跑本块相关测试；无网络情况下可完成离线实现，但真实结果由 03 负责。

执行证据：直接回归与真实复验见[修复验证记录](../../notes/live-discovery-acquisition-fixes-2026-10-10.md)。其中 runtime 配置是环境前提，仅完善诊断；RSC 限流与 Springer 登录页继续保留，不通过其它路线绕过。
