# 03 · Web 上的全文取得情况

类型：计划（结果块）
负责：文献库页面显示当前范围的全文取得情况
状态：Pending

## Outcome

- 文献库在表头上方显示当前范围的一行：“全文已取得 n / 总数 m，未取得 k（其中自动途径已试完 j）”。数字按论文计；每个数字是链接，在当前范围上应用对应的筛选。
- 快速筛选“有 PDF”改为“有主 PDF”（之后处于什么状态都算），“仅元数据”是它的补集，“无法获取”仍是已试完的文献。
- 数字与 CLI、MCP 读到的 `full_text` 相同（02）。显示不发起获取。

规格：[页面规格“文献库”](../../architecture/web/page-specs.md#文献库)的“全文取得情况”与“快速筛选的含义”两条；数字的含义见[查询技术篇 2.1.8](../../architecture/technical/06-retrieval-context.md#218-文献库计数与全文取得情况)；视觉规则见[设计内核](../../architecture/web/design-core.md)。

## 进入条件

02 完成（规格已补齐）。3.2 起与计划 21 的 10.6、计划 22 的 04 确认 `Library.tsx` 的先后（它们都改文献库的筛选区域）。

## 责任边界

- 负责：前端实施者。页面规格已由总设计师写好（01 的 1.3）。
- 触达：`apps/web/src/app/features/library/Library.tsx`（快速筛选与计数一段：`countFor` 与快速筛选列表，现在“有 PDF”是 `ASSET_READY`、“仅元数据”是 `UNREVIEWED`）；`apps/web/src/app/data/library.ts`。
- 不改：文献库的虚拟列表与行渲染；“已就绪”“建档中”“建档失败”“无法获取”的含义；服务端。

## Tasks

- [ ] **3.1 数据**：读取 02 的 `full_text`；类型来自 `packages/contracts`。
- [ ] **3.2 全文取得情况一行**：按页面规格的位置与写法；j 为 0 时不显示括号，范围为空时整行不显示；进行中的获取任务结束后，随现有刷新更新。
- [ ] **3.3 链接**：已取得 → 有 PDF（`has_primary_pdf: true`），未取得 → 仅元数据（`has_primary_pdf: false`），已试完 → 无法获取（`needs_manual_pdf: true`），总数 → 全部；只改快速筛选，保留当前范围的其它条件。
- [ ] **3.4 快速筛选的新含义**：“有 PDF”“仅元数据”改用 `has_primary_pdf`；它们的计数取 02 的 `with_primary_pdf` 与 `total − with_primary_pdf`（按版本，与列表一致）。
- [ ] **3.5 指南**：同步 [Web 指南](../../guides/web-workbench.md)中文献库的描述（实现合入后写）。

## 集成与影响

用户可见：打开任一范围就能看到全文取得情况，不用逐个点快速筛选相加。

## 验证

- 扩展 `apps/web/test/next-library.test.ts`：一行的数字与合成数据一致（含一篇论文两个版本的情形）；切换文件夹、入库批次、筛选时随之变化，切换快速筛选时不变；每个链接应用对应的筛选并保留其它条件；“有 PDF”包含已建档、建档失败与已排除的有 PDF 的文献，“仅元数据”是其补集；打开与切换范围不发起获取请求。
- `design-rules.test.ts`、`design-consistency.test.ts` 照常通过。
- 截图：全库、一个入库批次、一个文件夹三种范围，放 `sandbox/reports/`。

## 证据

提交号（G-commit 之后）；Web 定向测试结果；截图位置。

## 退出条件

Web 显示与机器入口一致；05 的真实运行结果 Owner 可以在 Web 上看（部署后）。

## 恢复与交接

与计划 21、22 同时改 `Library.tsx` 时停下商定顺序，不覆盖对方的改动。
