# 已有材料与处理结果检索

只读检索已有书目、固定校订稿与算子结果，并返回可核对的来源。缺少材料或索引时报告缺口，不自动发现、下载、建档或生成总结。

- [index.ts](index.ts)：可重建的材料索引；核验来源后有界批量发布，保留取消及 source revision 校验。
- [query.ts](query.ts)：书目与固定文档上下文、来源证据和分页。
- [knowledge-query.ts](knowledge-query.ts)：当前混合上下文（schema 3）。先保留材料检索排序，再读取算子结果；结果按固定 ID 顺序续读，使用结果 ID、内容哈希和记录 ID，不读取旧知识 artifact。
- [storage.ts](storage.ts)：离线检索存储适配。结果检索复用 [storage/processor-results.ts](../storage/processor-results.ts) 的投影、固定字节校验与证据解析，不维护第二份知识索引。

分页游标绑定查询和范围，算子结果分页冻结开始时的发布范围。读取预算限制最终 JSON 大小与核验字节；来源损坏报告缺口，已有可靠分支保留。原始事实分别归 Literature、Document 和 Analysis 所有。

[上级目录](../README.md)
