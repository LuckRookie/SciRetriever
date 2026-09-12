# TypeScript MinerU backend 运行证据

2026-09-11 起，Application 在 `parsing.connection_mode = "loopback"` 且配置了
`base_url` 与 `model_identity` 时自动组装 `MinerULoopbackParser`。该路径由
`parsing/backends/mineru/` 下的 TypeScript backend 负责 health、multipart submit、poll 和
archive 请求，再由 backend archive converter 校验 ZIP、CRC、路径、大小、资源闭包和
ParserResult hash。
生产路径不启动 Python 进程，也不把服务任务 ID、原始 ZIP 私有文件或凭据暴露给上层。

远程连接模式使用同一份 `MinerUParser`，只有
`remote_upload_authorized = true` 且存在与配置 endpoint 完全同源的 MinerU token 时才组装。
上传使用独立 `parser-upload` credential grant，生产 Network 禁止 redirect；离线 TLS 旅程
证明 token 只进入配置 origin 的请求。loopback 路径即使 credential store 中存在 MinerU
token，也不会读取或发送它。

TypeScript server 源码和公开 export 已删除 `PythonParserArtifactRules`、
`ApplicationOptions.parserRuntime` 以及 Python bridge 入口，因此生产对象图没有调用
`sciretriever.parsing.mineru_bridge` 或 `artifact_bridge` 的路径。当前 `MinerUParser` 和
`MinerULoopbackParser` 只是 `ParserBackend` 的一个后端实现；Python 历史实现位于
`archive/2026-09-12-typescript-python-retirement/`，不进入 TS package。

归档转换只接纳当前 `vlm` primary quartet：Markdown、middle、model 与 content-list。
它检查 backend、物理页数与 page index、middle image 路径、content-list 顺序、严格 JSON、
CRC、加密/压缩方法、压缩比、逐项/总大小、重复及大小写碰撞、重复编码 traversal 和资源
闭包；私有 JSON 与未引用资源不会进入 ParserResult。解析、结构校验、发布、stale/CAS、
文件冲突或取消失败时，既有 current ParserResult 保持不变。

离线验证：

```text
pnpm exec vitest run apps/server/test/mineru-parser.test.ts
pnpm exec vitest run apps/server/test/mineru-http.test.ts
pnpm exec vitest run apps/server/test/parsing-artifact-rules.test.ts
pnpm exec vitest run apps/server/test/parsing-service.test.ts
pnpm exec vitest run apps/server/test/application-assembly.test.ts
pnpm quick
pnpm full
```

覆盖 loopback 协议顺序、multipart 字段、正式 PDF 页数、primary JSON/资源发布、错误状态、
任务标识、ZIP/CRC/路径/碰撞、Unicode 资源、取消，以及 remote 授权、exact-origin token、
redirect 拒绝和旧 current 结果保留。真实 MinerU 未获授权且未运行；T045/T061 的 inventory 与历史
处置记录已经完成，Python 文件不进入 TS 生产树。
