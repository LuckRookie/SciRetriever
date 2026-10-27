# Web 回归测试

类型：代码导航
负责：Web 回归测试
状态：现行

保存 界面状态、页面交互和 loopback Chromium 旅程 的可重复离线回归。测试以 \*.test.ts 命名，fixture/helper 与测试就近存放。

`next-remote-login.test.ts` 通过仅 loopback 的 fixture 代理，让 Chromium 以普通 HTTP IP origin 访问真实工作台，验证登录、深链接、保存视图、持久任务、非 secure-context API、退出和重新访问。代理只允许测试 origin，不访问外部服务。

`next-launch.test.ts` 验证正式 CLI 启动、空 home 默认建库、已有配置优先、书目导入和数据库路径保存后运行绑定不变；`next-jobs-parity.test.ts` 验证真实持久任务、部分失败/重试、控制及历史分页；`next-knowledge-journey.test.ts` 验证同源 PDF、解析、知识/身份加工、固定结果与证据阅读。`next-browser-control.test.ts` 验证直接点击、过期首次输入、交还失败和关闭确认；`next-parallel-browser.test.ts` 验证跨文章会话的状态、控制与候选隔离。外部 parser/model 使用 fake，SQLite、HTTP 和前端交互使用实际实现。

完整Chromium旅程按实际范围设置用例总时限，涵盖构建、浏览器启动和临时库生命周期，避免误用Vitest默认5秒总超时。异步回执与可恢复读取使用有界轮询；时限调整不弱化业务断言。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[测试目录与本机试验场](../../../tests/README.md)；[测试与验收规则](../../../HARNESS.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)

`next-reader-boundaries.test.ts` 使用正常登录的合成库覆盖自动有界续读与失败恢复、稳定段落、可调栏宽、窄屏来源信息；Browser 会话空态与引用取样/迟到图查询隔离分别由 `next-live-browser.test.ts`、`next-insights.test.ts` 覆盖。

React 阅读的直接行为回归在 `next-reader.test.ts` / `next-reader-boundaries.test.ts`：覆盖三视图、处理确认、总结证据往返、固定材料校验、连续加载/失败重试、资源释放、迟到响应隔离与真实 PDF.js 的 100 页合成样本。`reading-pdf-fixture.ts` 提供合成 PDF 及资源计数工具。`design-audit-fixture.ts` 与 `design-audit.test.ts` 提供可重复运行的可见控件计算样式审查；设置 `SCIRETRIEVER_DESIGN_AUDIT_OUTPUT` 才写入四主题/四宽度的截图矩阵，输出目录应位于 Git 忽略的 `sandbox/`。该报告不替代 macOS 实测或用户视觉验收，也不新增通用 CI 视觉门禁。

## React 验证

生产 Vite bundle 由 `next-workspace-fixture.ts` 装入真实同源服务；保留正常认证与 CSRF，数据仅写入系统临时的合成 home。`next-*.test.ts` 对应旧用例的业务断言，定位优先采用角色、标签及用户文字；固定引擎边界或虚拟列表测量使用明确测试标识/容器。不得通过删除业务断言、替换固定来源、自动补材料或吞掉失败来获得通过。新旧映射见 [功能对等清单](../../../docs/archive/2026-10-19-web-experience/parity.md)。

- `next-library` 在临时 catalog 中一次性生成 30,000 条有效合成元数据，验证真实查询分页、虚拟列表、范围上限、筛选、滚动与选择恢复。批量写入仅用于建立 UI 测试 fixture，不是生产入库入口或入库吞吐测试。
- `next-knowledge-journey` 覆盖从原始 PDF、显式持久解析 / DSH 分析 / 身份核验到固定结果和证据阅读的链路，以及默认解析发布和缺模型时的恢复说明。模型与解析器均为 fake。
- `next-query-cache` 验证 Browser 心跳不重复刷新文献库，实际材料发布和断线恢复触发缓存更新。
- `SCIRETRIEVER_REDUCED_MOTION=reduce` 可让共享 workspace fixture 用减少动效偏好重跑相同业务断言；不改变请求、状态或权限。

GB 确认后，20 个旧 UI 测试文件已随旧渲染器删除；业务断言由对应 React 用例继续验证。纯 Markdown 字节边界与候选状态测试、正式 CLI 非法参数断言保留。`processor-workspace-fixture.ts` 只组装合成库/服务/浏览器，必须由调用方提供生产 React 资源，不再暗中构建旧入口。最终质量结果以 Full 日志为准，单个截图或性能样本不等于全量通过。

隔离性能复测可设置 `SCIRETRIEVER_WEB_PERFORMANCE=1` 运行 `next-library.test.ts`，按计划核验50ms长任务口径；全量并发测试始终验证分页与有界DOM，性能数值另记，不把特定机器时延增加为全仓通用门禁。

`reading-markdown.test.ts` 独立保留 Markdown 的 CRLF/非 BMP UTF-8 原始边界与不安全 URL/HTML 隔离断言，不依赖页面框架。

`design-samples-browser.ts` 为样例测试和截图脚本提供同一页面清理流程：收到真实 `pagehide` 处理器的断开回执后才销毁 renderer，匿名页直接关闭。`design-samples-browser.test.ts` 用真实 `ApiClient` 验证连续 20 页、延迟断开回执与拒绝断开的场景；不依赖 `page.close()` 一定送达 keepalive 请求。
