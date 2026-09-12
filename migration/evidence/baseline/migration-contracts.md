# MIGRATION-CONTRACTS 证据

日期：2026-09-09；范围：TypeScript 迁移的架构边界文件；不读取历史研究档案、用户 Catalog、Profile 或凭据。

## 采用结果

已建立并互相链接的权威文件：

- [ADR 0024：TypeScript 与 Browser 工作台迁移边界](../../../docs/architecture/decisions/0024-typescript-browser-workbench-migration.md)
- [设计文档的 TypeScript 迁移映射](../../../docs/architecture/design.md#56-typescript-迁移映射)
- [TypeScript 与 Browser 工作台技术边界](../../../docs/architecture/technical/typescript-workbench.md)
- [产品需求](../../../docs/architecture/requirements.md)、[技术文档索引](../../../docs/architecture/technical.md)

合同明确了 TypeScript 当前生产入口与保留 Python 历史材料的关系，禁止生产双写；明确 Configuration、
Network、Browser Host、Agents、Acquisition、FileStore、DB Worker/Storage、Literature 和 Application/Entry
的唯一 owner；明确 CloakBrowser、`browser:generic`、逐次 Network admission、Candidate durable-ready、
PDF/文章归属双重验收、v1 文献事实与 v2 运行事实隔离，以及最终切换和真实数据操作的授权边界。

## 语义审查

实际检查了上述文件之间的链接、owner 对应关系和以下交接：

1. v1 Model/canonical/hash/schema/FTS/query/relations/assets 从 contracts/fixture 进入 Storage 与业务；
2. Browser 只能交付绑定文章的 Candidate，Acquisition 才能判断 PDF 和文章归属，Storage 只执行确认命令；
3. Network 是所有外部 I/O 的唯一安全出口，Agents 和 Browser 不取得 secret、Page、Context、CDP 或事实写入；
4. v2 job/attempt/event/candidate/receipt 只在合成副本中显式升级、备份、恢复和回滚，不能替代 Literature current facts；
5. 具体 SQLite binding、CloakBrowser binary、Provider endpoint 和真实站点结果没有被虚构为本合同已验证事实。

审查结果：通过。新增 ADR/技术文件只固化迁移边界，没有修改产品需求、v1 schema、用户数据或生产切换状态。
后续实现若改变 owner、公开合同、持久化语义或安全边界，必须回到对应真相源和决策记录。
