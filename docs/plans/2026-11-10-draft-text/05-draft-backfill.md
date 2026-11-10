# 05 · 为已有原始解析补形成初稿

类型：计划（结果块）
负责：按文献库筛选写明范围、显式发起的初稿补形成维护操作
状态：Pending

## Outcome

- 使用者或 Agent 用一次显式操作 `form-drafts`，为已经存在、但还没有初稿的原始解析形成初稿；打开 `include_older_method` 时，也为用旧方法形成的初稿重新形成。范围用 `AcquirePdfSelector` 写明（ADR 0052）。
- 提交前能看到预览 `FormDraftsCounts`。
- 操作作为持久任务运行，可以取消；回执逐篇逐部分给出 `FormDraftsPartResult`。
- 不调用模型，不联网，不解析。
- 正式库现有约 926 篇有全文的文献，可以经这个操作得到初稿（在正式库上运行要 G4 授权）。

规格：[04 §8.11](../../architecture/technical/04-document-evidence.md#811-补形成初稿的维护操作)（请求、预览、执行、回执、入口）；每个部分的形成按 [§8.2](../../architecture/technical/04-document-evidence.md#82-初稿的形成)。

## 进入条件

04 完成。5.6 需要 G2。

## 责任边界

- 负责：后端实施者。
- 拥有：维护操作的合同（`packages/contracts`）、应用层操作与持久任务、三端入口。
- 触达：
  - `packages/contracts/src/operations.ts`（任务操作种类）；
  - `apps/server/src/application/jobs/`（执行与进度）；
  - `apps/server/src/cli/main.ts`、`apps/server/src/workbench/http.ts`、`apps/server/src/mcp/tools.ts`；
  - 设备连接的用途表（MCP 工具按用途列出，见计划 20 的 07 块）。
- 复用：`AcquirePdfSelector`（`packages/contracts/src/intake.ts`）与“按当前筛选整体提交”的服务端解析方式；获取 PDF 与 `complete parser` 的持久任务机制（`application/jobs/service.ts` 现在的 `goal` 只有 `pdf` 与 `parser`）；04 的初稿发布服务。
- 不改：解析服务；建档；全文索引的刷新机制本身。

## Tasks

- [ ] **5.1 合同**：`FormDraftsRequest`、`FormDraftsCounts`、`FormDraftsPartResult`（04 §8.11）。任务保存 `scope: {selector, counts}`。
- [ ] **5.2 预览**：预览与创建任务用同一个选择函数（04 §8.11“预览”），只读，不形成初稿。
- [ ] **5.3 执行**：
  - 持久任务的目标为 `draft`，成员在创建时固定，上限与并发见 04 §8.11“执行”。
  - 核对现有持久任务的执行阶段（`execution_targets.stage` 的 CHECK 只有 acquisition、parsing、analysis、literature）能否表达这个目标。需要新阶段值时，它属于 schema 17，回到 03 一并加入，并交总设计师补规格。
  - 每个部分调用 04 的初稿发布服务；一个部分失败不影响其它部分和其它文献。
  - 取消保留已提交的初稿；未处理的目标按现有任务语义记为未开始。
- [ ] **5.4 全文索引**：每个默认文本改变的部分按 04 §6.5 排队请求刷新（04 §8.11“执行”）。确认现有刷新请求在排队中会合并，不会因上千篇形成而排起上千次整库刷新；若不合并，停下交总设计师，不自行改刷新机制。
- [ ] **5.5 三端入口**：按 04 §8.11“入口”：预览 `form-drafts-preview`（用途 `read`），创建任务 `form-drafts`（用途 `operate`）；CLI、HTTP、MCP 共用同一应用边界。
- [ ] **5.6 正式库只读副本试跑**（G2）：在副本上对全部有原始解析的文献预览并执行一次，记录篇数、失败原因分布、总耗时、每页耗时、索引刷新耗时。结果交 11 的 E1 复用。

## 集成与影响

- 新增一种显式维护操作和一种持久任务。
- 大批量形成会触发大量内容版本事件（从无到有）。这些部分此前没有可读文档，也就没有依据它们的加工结果，事件不会让已有结果过时。验证中要证明这一点。

## 验证

新增 `apps/server/test/draft-backfill.test.ts`（合成库），证明：

- 预览计数与已知数据相等，满足 `matched` 的等式；预览不写库；预览计数与创建任务后的成员一致（04 §8.9 末条）。
- `query` 范围先跳过再按 `sort` 取前 `limit` 篇；`literatures` 范围超过 10,000 篇时拒绝。
- `include_older_method`：关闭时旧方法的初稿计入 `skipped_has_draft`；打开时重新形成。
- 仅 Markdown 的原始解析：页归属唯一时形成初稿；不唯一时为 `failed` / `needs-parse`。
- 一个部分页面工具失败，其余照常；回执逐部分列出 `failure_code`。
- 中断后再次发起：已形成的部分计入跳过，不重复登记；创建任务后被另一操作先形成的部分为 `reused`。
- 取消后已提交的初稿保留，未处理的记为未开始。
- 已有校订稿的文献：形成初稿，默认文本不变，没有加工结果被标为过时。
- 全程模型适配器、网络与解析器没有被调用。
- 三端回执一致：扩展 `interface-maintenance-parity.test.ts`；MCP 工具按用途列出（预览在 `read`，创建任务在 `operate`）：扩展 `mcp-http.test.ts`。

## 证据

提交号；定向测试结果；5.6 的试跑报告位置与汇总数字（G2 之后）。

## 退出条件

维护操作三端可用；合成库测试通过。12 块在正式库上运行它需要 G4。

## 恢复与交接

任务中断不回滚已形成的初稿；重新发起即可续做。试跑失败时保留副本与报告，记录原因，不在正式库上重试。
