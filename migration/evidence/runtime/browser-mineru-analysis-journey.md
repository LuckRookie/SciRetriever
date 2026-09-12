# Browser → MinerU → Analysis 联合旅程

> 这是迁移期联合旅程的历史记录。当前生产 Parser 与 Analysis 为 TypeScript owner；本文件中的 Python adapter
> 仅描述当时的 oracle bridge，不代表当前 TS 安装包路径。

2026-09-10。`apps/server/test/browser-mineru-analysis-journey.test.ts` 在一个临时 home 中组装真实目标
Cloak Browser、WorkbenchSession、SQLite、FileStore、ConfigurationOwnerBridge、实际 `MinerUParser` 和
`AnalysisService`。Browser 从合成文章的 Observation 元素点击 `Download PDF`，Candidate 经 durable receipt
发布为当前 Literature 的主 PDF；随后 Completion 从正式 Asset 启动实际 MinerU bridge 和两阶段 Analysis。

MinerU 使用临时 loopback HTTP 服务，严格返回 3.4.4/protocol-2/vlm-engine 的 health、submit、poll 和 ZIP
result。ZIP 来自仓库的合成 fixture，按 Browser PDF 的单页页数裁剪，不含用户数据；迁移期 Python adapter 曾只在
bridge 子进程中转换中间 JSON、Markdown 和图片资源。当前 TypeScript Parser 直接转换同一闭合协议。Analysis 使用独立 loopback OpenAI Chat Completions 响应，第一
次返回最终 metadata，第二次返回正文草稿。两次服务调用均由 Application 的 NetworkBudget、AgentRuntime 和
Literature content owner 接纳。

测试断言：

- Candidate 捕获、发布和正式主 Asset 来自同一 Browser session；
- MinerU 请求顺序精确为 `GET /health`、`POST /tasks`、`GET /tasks/browser-mineru`、`GET /tasks/browser-mineru/result`；
- ParserResult 的 source name 为 `mineru`，model identity、输入 hash 和结果 provenance 保留；
- Literature 最终为 `CONTENT_READY`，Analysis 内容进入 current detail，Library relevance query 能找到该 Literature；
- 只访问 loopback fixture，临时配置由 Python owner 发布，未使用真实 MinerU、Provider、模型或凭据。

直接验证：

```bash
SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 \
  pnpm exec vitest run apps/server/test/browser-mineru-analysis-journey.test.ts
```

该切片通过；它补充 `product-loopback-journey.test.ts` 的固定 Parser fixture 和 `mineru-parser.test.ts` 的
独立协议测试，形成同一 Browser→Candidate→实际 MinerU→Analysis→Library 对象图证据。实际包内的静态资产
和公开入口另由 `package-entrypoints.test.ts` 验证；未将源码 checkout 路径冒充安装包运行时。
