# 04 · 解析后形成初稿与回执

类型：计划（结果块）
负责：每个发布原始解析的操作结束时形成初稿、设置默认文本，并在解析回执中报告初稿结果
状态：Pending

## Outcome

- 单独的解析、`complete parser` 维护操作、建档的第一步解析，结束时都形成该部分的初稿，不需要另外发起。
- 解析回执在逐 profile 的结果之外带 `draft`（`DraftOutcome`：`formed`、`reused`、`failed` 或 `not-formed`），字段见 04 §8.2“回执”。
- 没有当前有效校订稿的部分，默认文本成为初稿；Agent 用 `document describe` 读到它（等级字段在 07 块对外）。
- 初稿失败时原始解析、PDF 和其它部分的结果照常保留，解析本身不算失败。
- 全程不调用模型、不联网。

规格：[04 §8.2](../../architecture/technical/04-document-evidence.md#82-初稿的形成) 的“时机”“输入”“失败”“回执”，[§8.5](../../architecture/technical/04-document-evidence.md#85-默认文本内容版本与证据) 的默认文本与边界情形；文件与登记见 [07 §2.3.4](../../architecture/technical/07-versioned-storage.md#234-asset原始解析与校订稿)。

## 进入条件

02、03 完成（3.6 除外）。

## 责任边界

- 负责：后端实施者。
- 拥有：初稿发布服务（建议 `apps/server/src/document/draft-publication.ts`，与 `proofread-publication.ts` 并列）；`ParseDocumentReceipt` 的扩展。
- 触达：
  - `apps/server/src/document/service.ts`（`DocumentProcessingService.parseDocuments`，三个入口都经过它）；
  - `apps/server/src/entry/literature-completion.ts`（`complete parser` 的结果映射）；
  - `apps/server/src/archive/orchestrator.ts`（建档第一步解析）；
  - `apps/server/src/application/jobs/processing.ts`（`parse-documents` 任务的结果）；
  - `apps/server/src/cli/main.ts`、`apps/server/src/workbench/http.ts`、`apps/server/src/mcp/tools.ts` 的解析入口；
  - `apps/server/src/bootstrap/application.ts`（把 PDF 页面工具与文件存储交给初稿发布服务）。
- 不改：`RawParsingService` 的发布与失败语义；建档的整理、校订与发布；MinerU 适配器。

## Tasks

- [ ] **4.1 初稿发布服务**
  - 输入：文献、部分资产、调用方指定的原始解析（04 块传本次解析的结果，05 块按 04 §8.11 选择）。
  - 步骤：用本机 PDF 页面工具检查页面（与逐页校订同一个 `PdfPages`）；调用 02 的构建器；以 create-if-absent 发布不可变文件（初稿内容、Markdown、结构；差异记录在初稿内容里，图片沿用原始解析的资源对象，见 07 §2.3.4“文件”）；调用 03 的 3.3 在一个事务里登记版本、事实与当前初稿，并按 04 §8.5 重新求默认文本。
  - 身份相同的初稿已存在时为 `reused`，登记为当前、不重复登记版本（04 §8.2“版本”）。
  - 默认关系改变或删除时请求全文索引刷新，等法同校订稿发布：只等刷新请求持久化，失败不撤销初稿（04 §6.5）。
  - 关闭时等待在途工作结束；失败与取消按 04 §8.2“失败”的表返回，不登记部分产物。
- [ ] **4.2 接到解析操作的末尾**
  - `parseDocuments` 在 `parseAsset` 返回后，只在本次发布或复用了部署 profile 的原始解析时形成初稿；其余情形回执为 `not-formed`（04 §8.2“输入”“回执”）。`vlm-engine-markdown-only` 的初稿只经 05 的维护操作形成。
  - 初稿失败只写进回执的初稿结果，不改变逐 profile 的结果，不抛出解析失败。
  - 初稿形成在原始解析提交之后，单独提交；`ParsingCommit` 包装的写入顺序不变。
- [ ] **4.3 回执合同**
  - 扩展 `packages/contracts/src/document.ts` 的 `ParseDocumentReceipt` 与解析函数：增加 04 §8.2 的 `draft`（`DraftOutcome`，类型在 02 的 2.1）。
  - 解析函数现在按精确键集解析，所有生产者与消费者要同时更新。
- [ ] **4.4 各入口**
  - CLI `document parse`、HTTP 解析接口、MCP 的 `parse-documents`、持久任务结果：原样输出新回执。
  - `complete parser`：逐篇回执使用同一个 `draft` 结果（04 §8.2“回执”末条）；初稿失败不把结果记为 `parsing_failed`。
  - 建档第一步解析：使用同一个 `draft` 结果，记入该步的 `task_steps`；建档继续进行，不依赖初稿是否成功。
- [ ] **4.5 组装**
  - `bootstrap/application.ts` 中构造初稿发布服务并交给 `DocumentProcessingService`；没有 PDF 页面工具时初稿结果为 `failed` / `page-tools-unavailable`，解析照常。

## 集成与影响

- 解析变慢：多了整篇 PDF 的页面检查与对比。11 块测量真实耗时；这里只要求不阻塞事件循环。
- 新解析的文献在建档之前就有了默认文本。在 07 合入之前，现有读取方只接受 `schema_version: 2`，遇到默认文本是初稿会拒绝（04 §8.3），所以 04 与 07 必须在同一次部署中上线（12 块）。
- 重新解析会先删除默认关系、再形成新初稿（04 §8.5“边界情形”）；已建档文献重新解析后，默认文本从校订稿变为新初稿。
- 回执格式变化是公开合同变化，三端一起改。

## 验证

新增 `apps/server/test/draft-on-parse.test.ts`（合成 PDF、假的 MinerU），证明：

- 解析一篇有文字层的 PDF 后，回执的 `draft` 为 `formed`，`default_text_level` 为 `draft`；用 03 的读取函数与 02 的重建函数读到已知文字（对外读取在 07 验证）。
- 再解析一次（复用原始解析）：初稿结果为 `reused`，版本与字节相同。
- `--force` 重新解析得到新原始解析：形成新初稿，默认文本改为新初稿（没有有效校订稿时）。
- 已有当前有效校订稿时形成初稿（例如只补初稿的再次解析）：`default_changed` 为 false，`default_text_level` 为 `proofread`。
- `--force` 重新解析已建档的文献：旧校订稿失效，默认文本为新初稿；新初稿形成失败时该部分没有默认文本（`document-missing`）。
- 页面工具不可用、超过上限、来源篡改、原始解析提交后取消：`failed` 与对应的 `failure_code`；原始解析已提交，PDF 未变，逐 profile 结果为成功。
- 只请求另一种 profile：`not-formed` / `profile-not-requested`；部署 profile 解析失败：`not-formed` / `raw-parse-failed`，不改用以前的原始解析。
- 全程模型适配器与网络没有被调用。
- 取消与关闭：在构建中途取消，不留半条记录。

扩展：

- `literature-completion.test.ts`：`complete parser` 的结果计数包含初稿；初稿失败不算解析失败。
- `archive-orchestration.test.ts`：完整建档的第一步解析形成初稿，建档其余步骤不变。
- `cli-main.test.ts`、`mcp.test.ts`、`workbench-http.test.ts`、`interface-maintenance-parity.test.ts`：三端回执相同。
- `packages/contracts/test/` 中解析回执的合同测试：新字段的接受与拒绝。

## 证据

提交号；定向测试结果；一份合成解析的回执样例（放 `sandbox/reports/`）。

## 退出条件

三个入口在解析后都形成初稿，回执三端一致；05、06、07 可以开工。

## 恢复与交接

- 已形成的初稿是不可变事实，中断后不回滚；重跑同一解析得到 `reused`。
- 如果解析路径因为初稿出现回归，可以在 4.2 的接入点暂时不调用初稿发布服务，其余部分保留，记录原因后再修。
