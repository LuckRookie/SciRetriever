# 已有材料与知识检索

维护可重建的材料/知识索引，查询固定文档和知识产物并交付可展开的上下文。

## 内容入口

- [index.ts](index.ts)：材料索引构建。已核验来源先暂存，再跨来源合并有界批次写入，避免逐篇提交事务；保留空来源计数、取消与发布前 revision 校验。
- [query.ts](query.ts)：材料上下文查询。
- [knowledge-index.ts](knowledge-index.ts)：知识索引构建。
- [knowledge-query.ts](knowledge-query.ts)：知识与材料查询。

## 放置边界

查询缺少材料或索引时报告缺口，不自动发现、下载或生成总结；原始事实归 literature/document/analysis。

相关说明：[所属技术文档](../../../../docs/architecture/technical/06-retrieval-context.md)。

[上级目录](../README.md) · [项目 README](../../../../README.md)
