# Block 01：统一 PDF Candidate 捕获

## 状态与恢复点

- 状态：`Complete`
- 前置：无
- 下游：Block 02
- 恢复点：candidate 直接回归通过后进入 Browser 控制解耦

## 块结果

response、native download、viewer/blob 产生的文件线索进入同一个 operation-local candidate；candidate 可以独立等待和读取，不依赖 Agent snapshot。

## Tasks

- [x] **BOC01 — 统一 pending candidate。** 保存足够的内部资源引用和读取方式，使 response-only PDF 可以在没有 native download event 时完成 body 读取。
  - 验收：response body 完成后形成 capture；重复 download 不重复读取或发布。
- [x] **BOC02 — 处理候选读取失败。** body 未完成、响应不可读、超限或错误页候选只丢弃该 candidate，并保留其它候选和 Browser 会话。
  - 验收：错误 candidate 后仍可捕获有效 candidate。
- [x] **BOC03 — 补直接回归。** 覆盖 response-only、download-only、双事件、延迟事件、body 不可读和错误页面。
  - 验收：测试保护 candidate 生命周期和资源清理。

## 责任与改动面

- Owner：`network/browser.py`、`network/playwright.py`。
- 受保护行为：URL/DNS/credential forwarding、PDF 字节上限、不可变发布前的 candidate 语义。

## 验证与退出条件

相关 `test_network_browser.py`、`test_network_playwright_control.py` 通过，且 Quick 不新增诊断。

## 失败与恢复

若需要改变公共 `BrowserCaptureBatch` 或持久化合同，停止本块并回到设计审查；不在 candidate 层增加兼容桥。
