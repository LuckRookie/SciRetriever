# Provider 可选字段的有界容错

> 归档于 2026-10-11：本计划已完成，保留当时的授权范围、执行记录与验收边界；当前行为以现行架构文档、指南与源码为准。

状态：Completed。用户已同意：支持明确的协议，对无法解释的可选字段停止解析，保留其他有效内容；有明确依据且覆盖常见情况的规范化继续改进。适用于当前全部生产 Metadata adapters，不扩展为任意 JSON 解释器。

本轮沿用当前工作区的上一轮修复，不回滚、不提交，也不改真实 catalog/配置。没有新的业务模块、持久化诊断或自动修复状态；身份、来源、引用端点及中性合同继续严格。

## 实施范围与完成条件

- [x] 共享边界：文本空白、完整整数、日期精度、作者可选标识及资产提示按字段/列表项降级；运行诊断只记录 Provider、字段路径和稳定原因，不记录原值。
- [x] Provider 接线：Crossref、Europe PMC、Semantic Scholar、OpenAlex、DataCite、arXiv、OpenCitations，以及共用 record builder 的 CORE、Elsevier、Springer、Web of Science。保留各家字段映射，不增加猜测格式分支。
- [x] 响应/身份边界：缺失必要身份仍拒绝记录；响应主体和分页异常仍失败，不能被可选字段降级吞掉；损坏记录不能抹掉先前有效结果。
- [x] 验证：合成字段矩阵、各家正常形状与损坏可选字段、必要身份和协议反例、真实对象图接纳及相关回归；最终 Quick/Full，沿用 4 workers 避免机器负载引发 Web 超时。
- [x] 文档：供应商治理记录本次准则、截断范围和扩展条件；当前指南同步。最后注明验证范围和残余风险。

可接受改进包括同义文本空白、标准 ORCID URL、完整数字字符串、保留年/月/日的可信前缀；不接受递归展开未知对象、部分数字猜测、补出日期或用 LLM 修元数据。若某项实现没有实际覆盖价值，不新增抽象或配置。

真实服务验证不是本轮离线适配策略验证的前提；上一轮已保存实测记录，本轮不重复消耗真实 API/Browser。完成状态以源码、测试、对象图和 Full 为准。

## 当前证据与恢复点

- 全部 11 家供应商（含 Web of Science 两个产品）生产转换已接线；保留厂商显式映射。
- `metadata-field-boundaries.test.ts` 与 `metadata-adapter-boundaries.test.ts` 新增 68 项直接测试，
  包含局部舍弃、常见转换、原始项预算、协议错误、原始记录 hash、生产对象图入库与重开读取。
- 关联回归：`pnpm exec vitest run apps/server/test/metadata-*.test.ts apps/server/test/discovery-citation*.test.ts`，
  16 文件 / 142 项通过，日志 `/tmp/sciretriever-provider-all-related.log`。
- `pnpm quick` 通过；日志 `/tmp/sciretriever-provider-quick.log`。
- Full 通过：`VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm full`，
  日志 `/tmp/sciretriever-provider-full.log`：205 文件 / 1,448 项通过，15 文件 / 39 项按既有条件跳过，构建成功。

同时修正：OpenCitations 把整个列表算作一个扫描项、WoS Expanded 用页号代替起始记录号，
以及 CORE 在服务返回较小页时提前结束。WoS 在逐条转换时读取原始身份并计算原始记录 hash。
修复均有正常与异常路径测试，没有给单条文献或出版社增加特例。

合同变化仅为复用严格字段 parser 而增加 `parseAuthor`、`parseAffiliation`、`parseAssetHint` 导出；
中性字段 schema、配置、数据库格式及依赖不变。来源错误保持可见，有效接纳结果不随总体失败撤销。
本轮没有真实服务探测，不能由离线测试推导当前供应商网络、权限或在线成功率；未知可选格式仍会局部舍弃。

## 交付

最终 `git diff --check` 与涉及文档的相对文件链接检查通过；当前工作区同时保留上一轮发现/PDF 修复，
本轮没有提交、推送或清理这些改动。没有新增凭据、用户语料、真实 catalog 或构建产物到待交付文件。
治理规范与当前调用行为分别更新到 `docs/development/provider-governance.md` 和
`docs/guides/agent-interface.md`，入口目录说明同步到 `providers/README.md`。

后续遇到新的供应商形状，按治理规范判断它是常见明确转换、可选字段局部舍弃，还是协议/身份失败。
不以本计划作为新增格式白名单，也不因单个异常样本自动增加分支。
