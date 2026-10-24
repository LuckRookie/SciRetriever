# 02 · 文档结构与 Unit

状态：Pending。

## Outcome 与进入条件

01 已确定 Unit 与 DocumentVersion 规格。新解析的文档具备 parser-neutral 结构：章节、段落、表格网格（含表头、表注、脚注）、图与图注、公式、参考文献。每个 Unit 有稳定身份、内容哈希、所在页与区域、定位精度；Markdown 是同一版本结构的投影。检索按 Unit 建立。历史文档保持可读，缺少结构时如实报告缺口。

## 责任与 Tasks

- [ ] 2.1 MinerU adapter 保留原始输出包（按 01 中修订后的 ADR 0010 范围）。绑定 PDF hash、MinerU 版本、protocol 与参数；保留清单写入规格。入口为 `apps/server/src/parsing/backends/mineru/`。
- [ ] 2.2 中性结构转换：从保留输出生成结构初稿与位置映射。坐标尺度、页索引、旋转约定绑定 MinerU 3.4.4 / protocol 2 的实际字段，参考固定版本输出说明，不从新版协议推断。供应商私有字段留在 adapter 边界。
- [ ] 2.3 重写 `apps/server/src/document/builder.ts` 的结构构建：生成 Unit 与 Markdown 投影，保证两者在同一版本内一致；跨页表格关联多个原文区域，不伪造覆盖多页的坐标框。
- [ ] 2.4 程序检查：结构合法性、资源可达、坐标范围、表格行列跨度、图与图注关联、疑似重复或缺失；输出问题清单与质量报告，随 DocumentVersion 发布。
- [ ] 2.5 存储：新增 SQLite schema 版本与迁移，保存 DocumentVersion、Unit 及其映射；迁移只新增，不改写旧文档。入口为 `apps/server/src/storage/sqlite/`。
- [ ] 2.6 读取：`apps/server/src/document/read.ts` 提供按 Unit 读取，以及“单元格 + 表头 + 脚注”的上下文读取。证据引用支持页、区域、逻辑单元格、精确框四级精度，并保持旧证据引用可解析。
- [ ] 2.7 检索：`apps/server/src/retrieval/` 按 Unit 建立全文与语义索引；检索分块是派生单元，调整分块不改变 Unit 身份。
- [ ] 2.8 旧数据：没有结构输出的历史解析返回明确缺口；不自动重解析，也不从 Markdown 猜测坐标。

## 验证与退出条件

- 用 `tests/` 下的合成 MinerU 输出 fixture 覆盖：多栏阅读顺序、旋转页、跨页表格、合并单元格、图注关联、公式、参考文献。
- 用例需证明：同一输入重建时 Unit 身份稳定；坐标转换正确；Markdown 投影与结构一致；旧文档读取和旧证据引用不回归。
- 定向测试与 Quick 通过。

## 恢复与交接

不处理复查与修复（见 08）。完成后记录 Unit 身份规则的最终实现、保留文件清单、新 schema 版本号，以及 03、04 使用的读取接口。

[计划入口](README.md)
