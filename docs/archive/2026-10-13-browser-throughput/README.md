# Browser 获取持续补位与传输计时

上级：[历史归档](../README.md)。状态：Completed；日期：2026-10-13；Owner：Codex。

## 目标与授权

用户已授权落实持续补位、及时完成通知和传输分段计时，并用原固定样本检验真实改善。
原 50 篇的 36 分钟是八轮工程重跑累计，不作为干净 A/B 基准。本次保留当前编译产物作基线，
在两个独立无 PDF 的测试库中复用同一批元数据、选择顺序与正式配置，逐次运行。
真实请求通过正式 Configuration/Credential owner；不输出 secret，不改生产 catalog、系统 DNS、
Profile 设置和用户配置；不执行 Git commit/push。已有工作树改动全部保留。

## 设计与责任

Entry 改为有界目标 worker，完成一篇立即领取下一篇，每篇独立保持
direct → publisher-api → general-api → public-web → Browser 顺序。最终 Report 按冻结
目标排序，进度随单篇结算发布。操作 ID 和代次在同一运行中稳定，恢复不能使兄弟会话过期。
共享提交串行、取消与停止后续准入、已发布事实、来源隔离和版本选择保持。

Browser 的 5 秒动作节奏、300 秒活跃预算、两个决策 worker、会话 cap、同平台串行和
30 秒冷却继续生效。达到真实并发/保留容量时仍需等待；不承诺任意队列都满负荷。
复用 transfer 事件和 Logging，分清传输、接收、检查、候选交接与发布，不新增持久状态或监控服务。
既有 acquireCohort 调用方保留五层执行能力；生产 Completion 使用独立单篇顺序流，
批量 Browser 结果也逐篇通知。ADR、技术说明与当前使用文档同步。

## A：有界连续执行（Completed）

- [x] A1：替换固定 chunk，保持冻结范围、并发上限、即时进度、最终顺序与共享错误/取消语义。
- [x] A2：移除无生产消费者的 participant 屏障；补入目标沿同一操作身份执行；替换旧时序测试。
- [x] A3：批量 Browser 逐篇通知，不等慢兄弟，最终数组仍保持请求顺序。
- [x] A4：测试慢 A 尚未结束、原下一块 C 已完成；新目标不取消原下载；取消/停止准入和后续内容阶段保持。

## B：分段计时与真实对照（Completed）

- [x] B1：传输 owner 记录路径类型、开始、首次可观测字节、采样进度、网络与 Intake 结束；验收 owner 记录接收、检查、候选完成。仅记录稳定 ID、时长、字节和结果码。
- [x] B2：用合成流验证原生与 response stream 计时、低频采样、失败/取消及无 URL/凭据。
- [x] B3：独立测试目录保存同一 50 篇及来源观察。基线与优化版各执行一次正式任务，核对实际文件/hash/可读性；不复用旧 PDF、不替换失败样本、不运行中改代码。
- [x] B4：分析 ACS 分段时间、Bentham/Thieme 停止行为；报告成功数、墙钟、模型调用、文件大小和差异，说明外部环境影响。

## C：真实验收发现的后台预览误捕获（Completed）

- [x] C1：人工检查全部文件首页并记录 hash，修正文件通过与主文档成功的口径；基线 4 份、首轮优化 5 份补充材料不得计入正文。
- [x] C2：单独复现 3 篇，定位为主 frame 的后台 Fetch PDF 抢先入库；其中一篇模型尚未返回动作就被取消，不采用 iframe/最近点击或 ACS 域名规则。
- [x] C3：普通 Fetch/XHR inline PDF 交给 renderer，保留明确 attachment 原响应 IO 与 native/popup/data/blob 下载；不恢复 DOI/标题身份门。合成预览与 206、旧文档资源清理回归，保持实际 writer 生命周期。
- [x] C4：第三个无 PDF 的独立库按同一 50 篇完整执行，核对主文档、文件、模型调用、失败与耗时；它与前两轮分别记录。
- [x] C4a：修复收尾发现的结果优先级：早期 HTTP hint 的渠道不可用不覆盖真实 Browser 失败；单篇/批量回归保留独立 fallback 与错误诊断。真实轮次不重写，报告单独说明此后只修正归因。
- [x] C5：最终 Quick、全部 Vitest 与 build；报告及导航收口，不改用户生产数据，不执行 Git commit/push。

## 验证与完成条件

直接入口：`database-completion-chunks.test.ts`、`pdf-acquisition-scheduler.test.ts`、
`browser-transfer-dispatcher.test.ts`、`browser-parallel-production.test.ts` 和生产对象图测试。
然后运行 Quick、全部 Vitest（Cloak 只访问 loopback）与 build。
必须覆盖跨原 chunk 边界补位，不只重复同批三篇并行。真实材料留在忽略的
`sandbox/cases/browser-throughput/`、`sandbox/runs/2026-10-13-browser-throughput/` 和 `sandbox/reports/`。

## 恢复与风险

共享故障停止剩余准入并结清已启动工作，已提交 PDF 保留；不引入迁移或新依赖。
Profile 顺序使用、网络/限流会影响 A/B；只报告实际差异，不宣称普遍提速保证。
真实失败保留整轮结果，定点诊断不与主测合并成单次成功率或耗时。
最终结果：

- 持续补位、即时通知、稳定操作代次、传输分段计时已实现；后台 inline 预览不再抢先作为主下载，明确 attachment/native/popup/data/blob 下载保留。
- 相同 50 篇、三个独立无 PDF 的测试库各执行一次完整正式任务：基线 625.295 秒、仅调度优化 378.868 秒、最终版 666.451 秒。原两轮 47 份有效 PDF 中分别有 4/5 份补充材料；最终 47 份经首页人工复核为主文档，文章身份标签仍为 unverified。
- 最终第 47 个完成通知在 282.316 秒，剩余 384.135 秒等待失败目标收尾。整批相对基线慢 41.156 秒，不能宣称最终总耗时降低；两个 Bentham 均耗尽活跃预算，三个失败目标占 40/47 次模型调用。现场网络、Profile 和模型决策存在变化，不把全部差异归因于调度。
- 结果归因修复发生在最终真实轮次之后，只修正早期渠道不可用覆盖 Browser 实际失败的问题；原报告和计时保留原样，单篇/批量及生产组装的离线回归证明新的错误选择。
- 最终 Quick、全部 Vitest（3 个 test worker，Cloak 只访问 loopback，226 文件 / 1697 项全部通过）与 build 通过，退出码 0；直接回归 5 文件 / 97 项和追加 assembly 2 项通过。
- 完整测试中曾发现一个旧结果断言及一个默认 5 秒的知识证据回读超时：前者同步到新合同并保留有效断言；后者原样单项复跑 3.620 秒、最终完整运行 4.228 秒通过。未修改该测试、全局超时或产品预算。中断与失败日志全部保留，没有计入通过。

本机证据：`sandbox/reports/browser-throughput-validation-2026-10-13.md` 与
`sandbox/runs/2026-10-13-browser-throughput/`；最终质量日志 `full-verified.log`。
所有真实材料在 Git 忽略范围，未改生产 catalog、配置、凭据或系统 DNS，未执行 Git commit/push。

首次准备漏传 Browser bundle，已完整结束并移至 preflight-runtime-missing，不计入对照。脚本已在任何正式请求前检查 Browser runtime，后续 run 必须携带已验证 bundle。
