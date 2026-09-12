# MinerU 实际执行适配与受控 loopback 旅程（历史 bridge 证据）

> 本文件前半部分保留迁移期 Python bridge 的协议证据。当前生产 Parser backend 是纯 TypeScript
> `MinerUParser`/`MinerULoopbackParser`，不启动 Python 子进程；下文历史 bridge 描述不代表
> 当前安装包运行路径。

2026-09-10。阶段 05-05 的 Parser 执行部分，连接此前的 [Parsing 准备与发布](parsing-publication.md)。

## 历史 bridge 已实现

迁移期 `MinerUParser` 通过 Python 子进程执行现有 `OperatorManagedMinerUAdapter`，保留其物理 PDF
检查、120 次轮询限制、MinerU 3.4.4/protocol-2/vlm-engine 合同、ZIP 转换、资源接纳及 provenance 参数 hash。
子进程只接收 PDF 字节、稳定源 ID/hash、model identity 和有限服务响应；不加载用户配置、不打开 catalog、
不发布文件、不持有凭据或 HTTP client。

Python `_Service` 经逐行 stdio 发出四种固定请求：health、submit、poll、archive。TS 解析闭合对象，检查
调用阶段、任务 ID 归属和总调用次数，自行构造 URL 和 multipart。请求消息不能指定 URL、Header、路径或凭据。
submit 只携带 PDF hash/大小校验，TS 上传此前读取的确切 PDF 字节，子进程不能替换上传对象。

TS 网络层显式限定配置的 HTTP loopback 地址和端口，使用 Application 的共享 NetworkBudget 与已验证连接。
所有 HTTP 请求禁止重定向和重试，JSON 上限 1 MiB，ZIP 上限 64 MiB；健康、轮询及提交/归档分别采用
10/30/120 秒单次期限。bridge 默认总期限 180 秒，可显式调整至最多一小时，取消同时终止请求和子进程，
结束时等待子进程关闭。stdio 总输出和单行输入有 360 MiB 上限；PDF 上限沿用 256 MiB。

公开构造路径：

```ts
const runtime = { python: absolutePython, moduleSearchPath: absoluteSourceRoot };
const app = await createApplication(syntheticHome, {
  configurationOwner: runtime,
  parserRuntime: runtime,
});
const prepared = await app.parsing!.prepareCurrentPrimary(literatureId, signal);
const result = await app.parsing!.commitCurrentPrimary(prepared, signal);
```

`parserRuntime` 只在配置完整、connection_mode 为 loopback 时组装；与直接注入 `parsing` 二选一。
组装不访问解析服务，只有显式执行解析时才发请求。未指定 runtime 时沿用此前未组装行为。

## 直接测试

`apps/server/test/mineru-parser.test.ts` 由 Vitest 驱动。使用 Python stdlib ZIP 和已有 PyPDF2 运行依赖生成
两页合成 PDF、现有 MinerU fixture ZIP，不运行任何 Python 测试文件。

- 通过实际 ConfigurationOwnerBridge 发布临时配置，Application 读取同一配置并组装实际 MinerUParser。
- 实际 HTTP server 核对健康检查 → multipart PDF 上传 → 当前任务轮询 → ZIP 下载的路径、顺序与上传字节。
- 真实 Python adapter 将 ZIP 转为 ParserResult；TS 发布后从完整 Detail 和 artifact Port 读取。
  catalog 只含 PDF、规范 Markdown、引用图片三个 artifact，私有 ZIP 调试项不进入产物。
- 不兼容 release、重复 JSON 键和重定向在健康阶段拒绝且不上传 PDF；危险 task ID、任务 ID 不匹配、404、
  failed 状态及损坏 ZIP 在相应实际请求后拒绝。测试核对请求次数，避免把更早的无关失败误算作协议覆盖。
- 正在等待 HTTP 时取消，确认 parse 返回受控取消并完成子进程清理；已有取消信号、缺失解释器、过期期限
  都不上传 PDF。拒绝非 loopback、带凭据/查询参数的 URL，以及非规范 IP 写法。

此前的一次测试错误来自未显式提供 Network policy 所需的 loopback 地址白名单，修正为配置地址和端口双重
限定；不放宽 Network 的公共准入规则。配置 fixture 改为由实际 Python owner 发布后验证组装，符合单写入者路径。

## 联合旅程

`apps/server/test/browser-mineru-analysis-journey.test.ts` 已把实际 MinerU HTTP bridge 接入真实目标 Cloak
Browser 捕获、Candidate 正式发布、Analysis 两阶段接纳和 Library query；详见[联合旅程证据](browser-mineru-analysis-journey.md)。

## 剩余范围

本次只实现受控 loopback 模式，未启用 remote upload/远端凭据转发；未连接真实 MinerU、LLM 或 Provider。
没有新增依赖、v1 schema 或用户数据迁移。TS 安装包不包含 Python bridge，也不会由 npm tarball 启动 Python；
历史 bridge 已按退役报告移入 `archive/2026-09-12-typescript-python-retirement/`，不影响 source-checkout 临时
home 的联合旅程证据。

## 本次验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
历史切片验收通过：66 个测试文件、239 项测试，包含目标 Cloak 的真实 loopback 工作台、离线包安装、配置
TUI/owner 和本次实际 MinerU bridge，日志 `/tmp/sciretriever-mineru-full.log`。最终整库验收进一步通过：85 个
测试文件、352 项测试，日志 `/tmp/sciretriever-plan-full-final.log`；未运行 Python Quick/Full/unittest，未执行
commit/push/PR 或真实数据操作。

## 2026-09-12 当前 TS 复验

当前生产路径使用 `MinerUParser` 和 `MinerULoopbackParser`，Parser/ZIP 转换、内容接纳和
Application 组装均不启动 Python。`pnpm full` 在未设置 Cloak bundle 的环境下通过 119 个测试文件（3 个 skip）
和 466 个用例（4 个 skip）；依赖 operator-managed Browser bundle 的联合旅程保持 skip，真实 MinerU/LLM/Provider
仍未连接。
