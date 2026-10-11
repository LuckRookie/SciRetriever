# 02 名称维护

状态：Completed。

## Outcome 与进入条件

用户能显式汇总文献库里的不同出版社名称，默认通过规则匹配；可选让已有分析模型对未知名称产生受约束建议，再显式接纳选定别名供后续操作复用。元数据来源值与文献身份不改变，下载不必等待治理。

进入条件：Provider 稳定 ID 与可选 publisherAliases 合同；现有 Agents analysis 与 Configuration CAS owner 可用。真实运行只通过用户明确调用，开发测试使用合成 home/catalog/model。

## 责任与 Tasks

Provider 拥有静态别名与匹配；Entry 编排数据库范围和维护报告；Agents 只执行无状态模型调用；Configuration 拥有批准的普通配置映射。AI 不写 Literature 或路由权限。

- [x] 2.1 实现共享 `resolvePublisherNames(name, aliases?)`，规范化空白/大小写且保留原文；已知别名、未知和多归属冲突均有测试，定义不在各元数据供应商复制。
- [x] 2.2 配置新增可选 `sources.publisher_aliases`，缺省兼容；限制 Provider ID 与名称结构，跨归属冲突保持显式，继承现有 CAS 与凭据隔离；保存重读后可复用。
- [x] 2.3 实现按用户范围分页汇总的维护用例，按文献去重计数，保留来源身份和原文写法，同篇重复观察不增加文献数；同名分组避免逐篇模型请求，返回匹配结果、影响计数及必要上下文依据。
- [x] 2.4 显式 `--ai` 才调用现有 analysis 模型，输入已知候选 ID 与未知名称，校验输出名称集合、ID、结构及依据；畸形/未知结果不得成为已批准别名。
- [x] 2.5 提供正式 CLI/对象图入口与报告输出、显式接纳接口；接纳只修改选定普通映射，不覆盖 observation，也不凭模型自报 confidence 自动授权 API。
- [x] 2.6 将批准别名注入 01 的候选识别，测试默认无 AI、取消、报告重放、配置冲突、重启复用和原始元数据不变。

## 验证与退出

定向执行新 publisher-governance 测试与 configuration、CLI 相关回归；fake 模型要覆盖拒绝、未知 provider、缺项/额外项与重复名称。生产 bootstrap 必须提供维护服务，不能只导出无人调用 helper。

退出条件：用户可从合成 catalog 汇总到报告、显式接纳并重读配置；不配置模型仍可做规则汇总；同一输入只推理必要未知集合。当前不创建期刊目录、治理 DB 表或常驻后台。

恢复时保留已输出报告与已提交配置事实；CAS 冲突重新读取当前配置，不覆盖其它设置。单批模型失败不能删除已得到的规则匹配结果。

## 实施证据

2026-10-11 实现与定向验证完成；最终集成 Full 已通过，结果见 04 集成验收。

- 新增 `providers/publisher-names.ts` 与 `entry/publisher-governance.ts`；生产 `Application.publisherGovernance`、CLI 和 Entry 的 `publisher_aliases` 注入均已接通。复用 `TypeScriptConfigurationOwner.publishConfiguration` 的 CAS 更新，无需新增 owner 状态、数据库表或模型角色。
- `maintenance publisher-names` 支持 `--all`、重复 `--literature-id` 或 `--query` 范围，缺省只做规则汇总；`--ai` 才调用模型，`--output` 使用既有 create-if-absent 导出。`maintenance publisher-names-accept --report FILE --name NAME` 只接纳显式选中的有效建议，并校验报告对应配置 revision。
- 报告按规范化名称分组，`raw_names` 保留来源写法与各写法的文献计数；`literature_count` 对文献去重，`source_names`、站点 Provider 与有界文章样本提供来源依据。报告不单独输出 observation 数量，不把多条来源观察误计为多篇文献。
- 维护层按 200 条分页，默认最多扫描 10000 篇，未完成时返回 `next_cursor`；底层仍复用现有 `LiteratureQueryService.search` 快照查询，本次没有新增 SQL 分页体系。AI 每批最多 20 个未知名称，默认最多 20 次请求，超限和模型失败保留在报告中。

已运行验证：

```bash
pnpm exec vitest run apps/server/test/publisher-governance.test.ts
pnpm exec vitest run apps/server/test/configuration-owner.test.ts apps/server/test/cli-main.test.ts
pnpm exec vitest run apps/server/test/pdf-acquisition-scheduler.test.ts apps/server/test/pdf-five-stage.test.ts
```

- 名称维护新增 15 个测试通过：规则与冲突、重复名称、分页续扫、默认零模型请求、畸形模型结构/未知 ID/重复输出/额外 confidence 拒绝、站点冲突、AI 预算与取消、显式接纳、旧报告 CAS 拒绝、重启复用及原始来源不变。
- 配置 owner 与现有 CLI 回归共 22 个测试通过；普通配置无别名时的缺省投影保持兼容。新增治理文件及修改的配置/CLI/bootstrap 文件定向 ESLint、Prettier 和 diff 检查通过。
- 获取集成首次联合验证的 44 个测试通过；新增 SICI DOI 回归后，五层测试为 29 个，已随 Root 的 source-locator/application-assembly 三文件联合验证 61/61 通过。调度测试的 16 个此前已通过，本次未重新联合运行。保存后的唯一别名会稳定前移适用候选，冲突保序，错误别名不使缺乏文章证据的 API 产生下载。名称到路由的闭环已由实际候选调用顺序验证。
- 所有验证使用合成临时 home/catalog、fake 模型或 transport；没有操作真实用户材料、凭据或外部服务。集成 Quick/Full 由 Root 统一执行，以上结果不单独构成最终全量验收。
