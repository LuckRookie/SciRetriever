# Candidate 的业务接纳入口

2026-09-10。本轮把持久 Candidate/receipt 发布接入实际 Application 的 Acquisition 服务，并增加 Literature
的 current-fact 准入规则。当前只接纳已有 Literature 的主 PDF，不创建或自动合并 Literature；Web 发布按钮已接入合成工作台。

## 实现与所有权

- `Application.execution.acceptance.accept()` 只接受 receipt ID、transfer ID、Literature ID 和 metadata
  revision/hash 基线。多余字段拒绝；调用方不能提供 accepted 结论、正式路径、资产 ID 或 provenance。
- Storage 的 `currentFacts()` 在同一只读事务内取得 Literature、metadata snapshot 和当前主 Asset，并在
  worker 返回边界解析闭合 `LiteratureCurrentFacts`。该投影是临时读取，不新增 current 状态列或 schema。
- Literature 的 `requireCurrentCandidate`/`admitPrimaryPdf` 拒绝 stale metadata、capture 归属不符、非 accepted
  证据和已有不同主 PDF。Acquisition 通过 FileStore 重读并核对 Candidate hash/size，再执行有界 PDF 工具，
  从实际内容形成 DOI/版本证据；没有 DOI 或当前证据不足时拒绝为 uncertain。
- Acquisition 在通过所有准入后形成内部 intent，provenance input hash 绑定 PDF，source record 与来源 URL
  来自 capture；observed_at 使用原始捕获时间。正式路径默认 `objects/<sha256>.pdf`；同 hash 的已有 catalog
  Asset 优先复用其 ID/路径，避免重复创建同字节资产。
- 新对象 ID 由带用途前缀的 canonical 输入 hash 形成，保证同 receipt 并发的意图一致。它不改变已有 ID，
  不用生成值重新标识旧资产。正式写入仍通过既有 CandidatePublisher 和持久 receipt。
- 同一 Literature 再收到相同字节时复用唯一主资产关系；新 provenance 和完整 receipt/capture 继续保存。
  现有主 PDF 的 hash、size、ID 或路径不同则拒绝。最终 commit 再比较 metadata revision/hash；不覆盖冲突资产。
- 重复 receipt 首先校验原命令的全部字段，然后复用原始 intent 并验证正式字节；已成功 receipt 可以在当前
  metadata 后续变化后重放。未完成 intent 则仍受原 CAS 约束，不把旧确认自动套到新版本。
- AbortSignal 在验证与提交前检查；进入不可变 publication 后完成提交或留下可对账 receipt，不宣称取消可撤销
  已确认事实。拒绝、PDF 工具失败和 stale 结果保留 durable Candidate。

## 直接证据

`apps/server/test/candidate-acceptance.test.ts` 使用真实 Application、SQLite worker、FileStore、PDF 工具和
合成 PDF，覆盖：

1. 应用关闭/重开后接纳；同 receipt 并发与重放；正式字节、来源 input hash 和 ASSET_READY；
2. 第二份同字节 Candidate 复用正式资产与唯一关系；已有非生成规则的 Asset ID/路径也正确复用；
3. 跨文章、不同 DOI、不同版本、stale metadata、不同主 PDF、额外 identity 字段与预先取消拒绝；
4. 读取 snapshot 后修改数据库，最终 CAS 阻断 publication，Candidate 保留，失败 intent 不留半提交；
5. 成功 receipt 在 metadata 后续变化及重新打开应用后仍可复放。

原 `candidate-publication.test.ts` 的不可变文件、receipt 冲突、丢失/篡改字节、进程中断和对账测试继续适用。
新增只读快照修正了返回作者中泄漏 SQL ordinal 字段的问题；公共 Author 仍使用既有合同。

本轮验收：`SCIRETRIEVER_CLOAK_BUNDLE=<verified-bundle> pnpm full` 通过，57 个测试文件、200 个测试，
包含目标 Cloak/实时工作台旅程；日志 `/tmp/sciretriever-candidate-acceptance-full.log`。未运行 Python Harness
或 unittest；未修改 v1 schema、锁定依赖或已有文献 ID。

## 剩余范围

Metadata observation 的身份创建/合并 owner、CONTENT_READY 派生与查询 Detail、正式 Asset 的 Parsing/Analysis
接续均已在对应 Application 测试中验证；Web 放弃由独立[Candidate 回收证据](../runtime/candidate-abandonment.md)
和真实 Cloak UI 旅程覆盖。超过 100 项的工作台视图分页仍未作为首阶段支持声明；PDF 身份证据目前仅覆盖已实现的
DOI/版本规则，没有足够证据的真实 PDF 会保守留为 uncertain，不把合成 PDF 通过外推为所有文献已支持。

## Web 发布与重启读取

`POST /api/candidate/accept` 复用 loopback Host/Origin、cookie、每 tab CSRF 和有界请求体检查。命令闭合为
session_id、control_epoch、transfer_id、sha256；WorkbenchSession 要求当前 human controller，校验候选存在及
匹配 hash，使用服务端捕获的 metadata baseline 调用接纳服务。页面操作结束后可重新获取审核控制权，不会
重新启用已经终止的 Browser 动作。Agent 不获得此入口。

发布验证期间接管、释放、暂停、取消或断开控制者会触发 AbortSignal。关闭 session 会等待该发布结束再释放
其依赖；已经跨越提交边界的成功事实仍显示为已发布，不因控制权后续变化而撤销。Session 测试验证旧控制者、
hash 不符、接管中止和取消页面操作后继续审核。

合成工作台创建一条固定 synthetic Literature，以其稳定 ID 绑定 capture。相同 home 重新组装时，从 execution
catalog 读取当前文章前 100 项 Candidate，重新验证 PDF 和 capture 归属；已发布项还验证正式文件，恢复原
receipt，待处理项使用当前 review baseline。原 receipt 的 intent 基线保持不变。这个读取过程不自动发布。

前端面板提供「发布到当前文献」和「已入库」，通过 SSE 同步各查看者。候选 DOM 按 transfer ID 保留，正常
轮询不会不断替换按钮导致键盘焦点丢失。`live-workbench.test.ts` 在实际目标 Cloak 上从 download 捕获并发布，
再捕获 response PDF；关闭 Browser/HTTP/Application 后用同一临时 home 重启，确认两项及原发布状态恢复，
再从 Web 发布待处理项。最终 assets=1、literature_assets=1；仍覆盖双查看者接管与 390px 抽屉。

`pnpm preview:workbench` 是一次性展示入口：正常退出清理它自己的临时 home，重新执行命令开始新示例。
跨重启恢复使用保留同一合成 home 的明确组装与测试，不读取用户数据。

Web 发布切片 TS Full 已通过：57 个测试文件、202 个测试，包含目标 Cloak 的发布/关闭重启/恢复再发布旅程。
日志 `/tmp/sciretriever-workbench-publication-full.log`；没有运行 Python Quick/Full/unittest。
