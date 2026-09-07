# Block 03：终态候选与文献 PDF 验收

## 状态与恢复点

- 状态：`Completed`
- 前置：Block 01、Block 02
- 下游：Block 04
- 恢复点：从 Browser 已能持续交接 observation/candidate 的 fixture 恢复

## 块结果

Agent 可以自由尝试多个入口；每个下载候选进入统一的临时、不可覆盖的验收路径。错误候选不会发布，也不会让 Agent 因程序误判提前退出；有效 PDF 通过后才结束会话。

## 责任与改动面

- Owner：`/root`
- 主要模块：`src/sciretriever/acquisition/sources/browser.py`、`src/sciretriever/acquisition/pdf_identity.py`、`src/sciretriever/acquisition/tiered_service.py`
- 直接测试：`tests/test_acquisition_browser.py`、`tests/test_acquisition_pdf_identity.py`、`tests/test_tiered_acquisition_service.py`
- 保持：TemporaryPdf、provenance、candidate key、不可变发布、primary PDF identity 和后续阶段不撤销已提交事实。

## Tasks

- [x] **ATV01 — 捕获与任务成功解耦。** Browser candidate 到达时只进入验证，不由 Agent 的动作、按钮文字、扩展名或媒体类型直接判定成功。
  - 验收：candidate 仍可被拒绝或等待；只有两道最终验收通过才产生 PDF_DELIVERED。
  - 依赖：ARS03。
- [x] **ATV02 — 验证失败后继续探索。** 把错误页、非 PDF、错文、supplement 或身份证据不足转换为下一轮可消费的中性结果，保留失败证据但不回滚已确认事实。
  - 验收：fixture 中 Agent 至少继续一次并可获得第二个候选；最终失败仍包含稳定 code/reason/action。
  - 依赖：ATV01、ABS03。
- [x] **ATV03 — 有效候选进入统一收敛。** Browser Agent loop 结束后，Browser 返回完整 capture batch；PDF identity 通过的候选交给既有发布流程，未通过的候选清理并允许其它候选/route 继续。
  - 验收：有效 PDF 通过统一字节与文章归属门后发布；不以 capture 事件或模型结论替代验收，provenance/hash/文章归属保持一致。
  - 依赖：ATV01、ATV02。
- [x] **ATV04 — 补齐候选序列回归测试。** 覆盖错误 HTML、验证页、错文 PDF、正确 PDF、多候选、Stop、timeout 和 cleanup。
  - 验收：不使用真实 PDF/Provider/用户 catalog；测试验证业务结果而非偶然内部调用次数。
  - 依赖：ATV01–ATV03。

## 执行方式与审查门

先确定候选状态与 Acquisition 归属，再改 controller loop，最后接入 tiered service。Block 退出审查必须确认：Agent 永远不能写入 Catalog，Storage 不自行推断业务成功，后续 Parse/Analyze 不接收未验收候选。

## 接口、数据与依赖影响

- 只调整 operation-local candidate/loop 行为；不新增持久化状态和数据库列。
- 不改变 PDF identity 的保守拒绝原则；若最终身份门过于严格，应另立需求/ADR，不在本块放宽。

## 验证与退出条件

```bash
uv run --frozen python -m unittest \
  tests.test_acquisition_browser \
  tests.test_acquisition_pdf_identity \
  tests.test_tiered_acquisition_service
```

退出条件：错误候选可拒绝并继续，正确候选可通过并停止，所有临时资源确定性清理；下游可开始文档和完整 Harness 验证。

## 失败与下游交接

若需要修改 Literature/Asset/schema 或让 Agent 直接提供 PDF 字节，停止并触发大架构门。否则把稳定的 candidate/validated/terminal 证据交给 Block 04。

## 完成证据

已完成证据：

- 相关回归命令同 Block 01，包含 `tests.test_acquisition_browser`、`tests.test_acquisition_pdf_identity` 和 `tests.test_tiered_acquisition_service`；共 `172` 项通过，`skipped=1`。
- 通过的候选序列：错误/HTML 候选被局部丢弃，Agent 可继续下一次动作；多候选以 `BrowserCaptureBatch` 交给 Acquisition；正确 PDF 通过字节与文章归属检查后才形成 `TemporaryPdf`/发布输入；后续 route 可继续且不回滚已经确认事实。
- 未覆盖：真实出版社下载内容、真实 PDF 归属差异和现场权限页面。
