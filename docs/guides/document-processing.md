# 解析已接纳 PDF 并发布文档版本

当前入口处理**已有、已接纳的主 PDF**。先从文献详情取得 Literature ID、Asset ID 和 PDF SHA-256，并确保对应 Catalog 为完整 v3–v9；普通解析命令不会升级 catalog。新库可通过[正式初始化/升级入口](upgrade.md)启用 v9，版本范围见[安装兼容矩阵](installation.md#当前-catalog-与-reader-兼容)。真实用户数据迁移仍需单独授权；历史单步合成演练见[文档 Catalog 迁移指南](document-catalog-migration.md)。

从源码构建后，明确重解析并发布表示：

```bash
node apps/server/dist/cli/main.js document parse --literature-id LITERATURE_ID --asset-id ASSET_ID --asset-sha256 PDF_SHA256 --mode reparse --json
```

如已有同一主 PDF 的 current ParserResult，可选 `--mode reuse-current`。此模式只读取已保存解析结果，不调用 Parser；缺结果会返回 `parser-result-missing`。`reparse` 总调用启动时已配置的 ParserBackend，未组装时返回 `parser-unavailable`；CLI 不接受临时 parser 参数。两种模式均不下载 PDF、不调用 Analysis/模型、不扩充文献库。输入 ID/hash 不匹配或 current 主 PDF 已变化时拒绝，不改用新主 PDF 重试。

第一次发布不传 `--expected-default-revision`，期望当前尚无默认版本。切换已有默认版本时传回执中的 revision，例如 `--expected-default-revision 1`。维护 Web 表单从文献库读取当前主 PDF，再通过受控维护读取自动填入当前默认 revision；用户明确选择复用或重解析。版本先按不可变字节和依赖发布，再尝试独立默认关系 CAS；若别人先更新了默认版本，回执仍返回已发布的精确 `document_version_id`，并以 `default_updated: false` 和当前 `default_revision` 表示冲突。重试相同表示返回 `published: false`，沿用首次发布版本的 parser provenance；不会覆盖旧版本。Parser 失败或表示构建失败保留 PDF 和此前有效文档版本。若 SQLite 已提交但调用回执丢失，入口仍报告带原因的发布失败；须明确重试并读取持久状态，不能把事前已存在的版本误报成本次发布或默认切换成功。

TS 入口为 `Application.documentProcessing.parseDocuments(request, signal?)`；完整维护对象图也暴露 `Application.maintenance.parseDocuments`。维护工作台 `/` 有同一操作的表单；其 `POST /api/v1/maintenance/parse-document` 采用协议 v1、JSON 请求、同源会话 Cookie、`X-Sciretriever-Csrf` 和 `X-Sciretriever-Protocol-Version: 1`。同一认证下的 `POST /api/v1/maintenance/document-default` 读取已选材料的默认版本 ID/revision，不修改数据。受控 Browser 工作台使用对应 `/api/maintenance/parse-document` 路由、协议头和该工作台自身的 CSRF。只读 QueryApplication 不提供加工入口。公开请求只包含五个固定字段：

```json
{
  "literature_id": "00000000-0000-0000-0000-000000000001",
  "asset_id": "00000000-0000-0000-0000-000000000002",
  "asset_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mode": "reuse-current",
  "expected_default_revision": null
}
```

当前结构 builder 只识别代码围栏和缩进代码以外的 ATX 标题，发布可验证的文本片段及其 UTF-8 byte 范围，并固定实际引用资源的 hash/大小。单次输入上限为 PDF 256 MiB、Markdown 8 MiB、资源 4096 个、单资源 32 MiB、资源合计 128 MiB；结构最多 100000 个片段、规范 JSON 16 MiB。已发布表示可从[独立文献库阅读](library-query.md)按固定版本阅读和复核证据。表格单元、图注关系、页码和 bbox 尚无定位能力。v3 起禁止旧已接纳材料清理和物理回收，v5 起的外部候选回执登记有限期输入保护；通用回收协议与明确失效入口仍待设计，不应把当前读取回调称作跨进程 GC 锁。
