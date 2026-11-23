# 服务端回归测试

类型：代码导航
负责：服务端回归测试
状态：现行

保存 核心业务、适配边界、SQLite/文件持久化、应用组装与安装后旅程 的可重复离线回归。测试以 \*.test.ts 命名，fixture/helper 与测试就近存放。

`dsh-foundation.test.ts` 使用真实 DSH 服务与合成模型响应，验证单次请求确经原生 LlmRuntime、schema/模型设置保留、纯文本和多图会话、证据工具反馈、会话隔离、稳定失败与关闭结算。现有 `dsh-runtime` 和 Browser/Analysis/综合/配置回归继续覆盖各消费者；fake 反馈正确不表示真实模型的科研内容质量已提升。

三端一致性测试 `interface-query-parity.test.ts`、`interface-maintenance-parity.test.ts`、`interface-transfer-parity.test.ts` 和 `interface-browser-parity.test.ts` 使用真实 CLI/MCP 适配、合成 catalog 与 loopback HTTP，验证固定输入、共享任务/配置/提取 owner、有界文件字节，以及 Browser 版本与控制租约。外部 Provider/模型/页面仅用 fake，不读取真实库。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[测试目录与本机试验场](../../../tests/README.md)；[测试与验收规则](../../../HARNESS.md)。

## 规模性能验收

从仓库根目录显式运行 `scale-acceptance.mjs`。它使用 14.1 的固定种子 20261121 合成库，各有 1 万／100 万篇书目和 1 千／10 万篇已取得全文的论文。准备脚本创建独立副本、迁移、补齐检索并完成回填。测量使用 Node 22.19.0、SQLite WAL 和回环地址上的生产工作台，同期由独立进程提交合成书目。验收按实测至少 100 篇／秒的提交速率判断负载是否有效。共用机器串行运行两个规模，各轮都设总时限。

每项最多取 20 次，从发出 HTTP 请求计到读完并解析响应。首页包含并行读取收进来列表的前 50 项和计数。工作集包含固定的万项文件夹、状态筛选、第一页、计数、分面及续页。搜索测相关度前 1,000 条排名的首批 50 项。任务详情含服务启动后对同一个有 2,000,001 条事件和 100 万条来源记录的任务的首次访问。数据准备、启动与登录不计时。

1m 的五项 P95 上限分别是 1,000、200、1,000、1,500、500 ms，来自[查询技术篇 2.4](../../../docs/architecture/technical/06-retrieval-context.md#24-规模与目标耗时)。同一查询和响应批量下，`P95(1m) / P95(10k)` 的上限取 3，给索引层级和共享机器的 I/O 抖动留余量。索引延迟从提交到活动索引修订覆盖该提交，按 250 ms 轮询算上界，最长 120 s。任务详情仍在执行时另测翻页、单篇、状态、PDF Range。任一短读超过 5 s 或产生日志 `sqlite-short-read-slow` 即失败。超过单项指标十倍时结束该轮采样，保留已测数据并返回非零。任务的紧接读取仅用于诊断缓存影响。

```sh
export COREPACK_ENABLE_NETWORK=0 npm_config_offline=true
pnpm build
report_dir=sandbox/reports/2026-11-23-scale-acceptance
mkdir -p "$report_dir" sandbox/runs
copy_10k=$(mktemp -d sandbox/runs/scale-acceptance-10k-XXXXXX)
copy_1m=$(mktemp -d sandbox/runs/scale-acceptance-1m-XXXXXX)
timeout --kill-after=20s 5m node apps/server/test/scale-acceptance-fixture.mjs 10k "$copy_10k"
timeout --kill-after=45s 5m node apps/server/test/scale-acceptance.mjs 10k "$copy_10k" "$report_dir/acceptance-10k.json"
timeout --kill-after=20s 15m node apps/server/test/scale-acceptance-fixture.mjs 1m "$copy_1m"
timeout --kill-after=45s 10m node apps/server/test/scale-acceptance.mjs 1m "$copy_1m" "$report_dir/acceptance-1m.json" "$report_dir/acceptance-10k.json"
```

两档测试须各自运行，即使 10k 已返回失败也保留它的 JSON 给 1m 对比。退出后仅删除这两个刚创建的副本目录。结果与日志留在本机报告目录。脚本不进入默认 Vitest。

任务详情的 `task-sidecar` 模式使用已准备的 1m 副本，从同一合成任务取 1 万、10 万和 100 万条来源记录三档。每档先读取一次生成旁路，再独立重启工作台 20 次，取每次登录后首个任务详情请求至响应解析完成的 P50、P95。写入进程沿用验收节奏，P95 上限为 500 ms。脚本同时核对 CLI 和 HTTP 并发读取并建缓存所得的详情，以及随后重启对该旁路的复用。指定一个新准备的副本，完成后按上面的方式删除副本。

```sh
timeout --kill-after=45s 9m node apps/server/test/scale-acceptance.mjs task-sidecar "$copy_1m" "$report_dir/task-sidecar-1m.json"
```

`search-windows` 在 10k 和 1m 副本上测相关度第一页。两档用相同合成词构造 1,000 与 10,000 个原始命中，1m 另测 100,000 个。测近全库词 `in`、常用词 `spectroscopy`、三高频词 `studies of in`、零命中的作者子串，以及文件夹内的高频词与零命中组合。从发出回环 HTTP 请求到解析首批 50 项，各取 20 次，断言 P95 ≤1,500 ms，同期提交至少 100 篇/s。准备索引词、启动和登录在计时之外。`search-windows-sweep` 直接测同一读事务内的 SQLite 首页 ID 查询，用独立入库进程模拟写负载，以逗号分隔的试验上限量作者筛选、近全库词和三词组合，再比较原生 BM25 首行与仅取 rowid 的耗时，估计全局词频成本。

```sh
timeout --kill-after=35s 5m node apps/server/test/scale-acceptance.mjs search-windows "$copy_10k" "$report_dir/search-10k.json"
timeout --kill-after=35s 8m node apps/server/test/scale-acceptance.mjs search-windows-sweep "$copy_1m" "$report_dir/sweep-1m.json" 60000,80000,90000,100000,120000
timeout --kill-after=35s 8m node apps/server/test/scale-acceptance.mjs search-windows "$copy_1m" "$report_dir/search-1m.json"
```

[上级目录](../README.md) · [项目 README](../../../README.md)

`workbench-auth-fixture.ts` 只服务隔离回归：使用合成密码、绑定 loopback，并经真实 `/auth/login` 为 HTTP/浏览器旅程取得会话，不绕过统一认证。默认对外监听和自动密钥由 `web-remote-access.test.ts` 验证。

`dsh-document-session.test.ts` 使用合成正文和栅格资源，验证真实 DSH 会话的未读提交拒绝、看图、回查、错误引用修正和完整 usage。`dsh-analysis-fixture.ts` 只提供 fake 模型政策，保留实际 DSH 工具循环；`browser-decision-fixture.ts` 驱动正式 Browser capability，不保留生产单次兼容入口。

`react-workbench-fixture.ts` 将实际 Vite 与阅读资源装入既有独立查询/维护 HTTP 服务。`document-read`、`knowledge-analysis`、`synthesis-service` 和 `knowledge-retrieval-migration` 的浏览器部分通过这个入口继续验证固定版本、来源绑定、证据续读、迟到响应隔离和历史 schema 读取；不另造测试专用业务 API。

`legacy-application-fixture.ts`、`legacy-parser-fixture.ts`、`legacy-parser-publication.ts` 和 `legacy-document-fixture.ts` 只为历史版本 的读取、固定证据和存储保护回归构造旧文档，不进入生产组装。正式解析入口的回归使用请求 profile 对应的 raw fake，明确断言不会发布 ParserResult 或 Document。`raw-parser-fixture.ts` 只将合成测试文字构造成两份 raw，无法访问网络。

- `proofread-document-publication.test.ts`、`proofread-document-migration.test.ts`：校订全文发布/复用/CAS、原始输入变化、页码证据防篡改、补充材料、对照续读、检索与迁移失败恢复；仅使用合成临时库。

`structure-rules.test.ts` 覆盖纯规则、图表、引用切分及结构条件；`structure-annotation.test.ts` 覆盖 DSH fake、不可变发布/复用、人工角色事务、并发和固定分页以及 CLI/MCP；`structure-annotation-migration.test.ts` 覆盖合成 v13→v14 的备份、回滚和重试。

`mineru-http`、`mineru-parser`、`raw-parsing-service` 与 `literature-completion` 使用新的原始解析路径，保留资源闭包、CRC/路径检查、凭据撤销、并发/取消、失败恢复与禁止隐式总结的断言。`parsing-service.test.ts` 仅验证历史 fixture 的不可变发布，不作为新生产解析已验收的独立证据。

`parser-application-fixture.ts` 给旧式合成文字生成器提供匹配的合成可见文字层，隔离占位 PDF 的实际渲染依赖；用于验证固定文档、读取、检索与交付，不证明 OCR 或校订质量。校订专用测试仍独立提供有冲突的文字层/原图 fake，保留错误处置与真实性断言。
