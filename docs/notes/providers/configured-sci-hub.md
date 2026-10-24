# Configured Sci-Hub

类型：外部事实
负责：Configured Sci-Hub
状态：现行

- 外部事实最后核对：2026-10-10（Asia/Shanghai），用户明确授权的低频真实调查与下载验证。
- 当前选择键：Acquisition `sci-hub`；不提供 Metadata 或引用发现能力。
- 默认关闭；用户启用后使用版本维护的镜像列表；custom `urls` 完整覆盖 builtin。
- 当前内置入口：`https://sci-hub.ru`。
- 生产实现：[定义](../../../apps/server/src/providers/sci-hub/definition.ts)、[Source](../../../apps/server/src/providers/sci-hub/acquisition.ts)、[locator](../../../apps/server/src/providers/sci-hub/locators.ts)。

## 入口维护与兼容性

镜像和重定向目的地会随时间变化；一次可用性结果不构成服务 SLA。内置列表由版本维护，当前已移除不能提供有效 DOI/PDF 流程的 `.kr` 入口，不改写用户 custom 列表，也不自动发现其它域名。

服务端可能跳转到其它公开文件页面；每跳仍由 Network 检查。静态 PDF 链接的阅读器 fragment 只影响展示，获取前应剥离 fragment 并保留 path/query。历史请求表、故障诊断与复验见测试记录（本地文件：`sandbox/reports/sci-hub-endpoint-observations-2026-10-10.md`，不随仓库分发）。

## 配置与对象图

```toml
[sources.acquisition]
mode = "custom"
providers = ["sci-hub"]
```

没有 mirror table 时跟随当前版本 builtin。自定义列表完整覆盖 builtin：

```toml
[sources.acquisition.sci-hub]
urls = ["https://mirror-one.example", "https://mirror-two.example/base"]
```

`urls` 是一到八个有序且规范化后不重复的普通 HTTPS URL；不接受 userinfo、query、fragment、
IP literal、隐藏路径分隔符或 dot segment。Reset 删除 custom table；Disable 移除选中的 Source
但保留 custom。配置读取、状态展示与 Source 组装不发起联网探测，也不根据 mirror 暂时可用性改写配置。

`ConfiguredSciHubSource` 从当前已接纳的 DOI 按镜像顺序生成 landing candidates；没有 DOI 时不适用。
DOI 逐路径段编码，保留 DOI 的 `/` 分隔。Source 只产生 locator，共享 public transport 负责 HTTP
与静态 PDF 声明，不读取页面中的题目或作者作为权威元数据。每个实际请求/redirect 按目的地选共享服务政策。

## 获取与失败语义

1. 请求 landing；可以直接返回 PDF，也可以通过 `citation_pdf_url`、PDF 链接或 iframe/embed 声明文件。
2. 相对 PDF 地址以最终 landing URL 解析，去掉阅读器 fragment，再经过原 URL、DNS、公网地址、端口与重定向检查。
3. 文件进入统一 Candidate spool 与 PDF reader；实际 PDF 可读、至少一页且满足文件合同后，沿正式 acceptance/publication 入库，文章身份标为未验证。
4. 普通无候选/404 可以尝试下一镜像；不假称成功。带 Retry-After 或 429 仍停止备用尝试。
5. 无限流反馈的公共 5xx 或已识别的普通传输故障保留原因，允许后续独立 API/Browser 继续；后续均未命中时不写自动耗尽。具体边界由 [ADR 0015 §7](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md#7-升级暂停与熔断语义) 定义。
6. 无 Retry-After 的 HTTP 5xx 按服务政策共享退避，项目默认 30 秒。重定向到同一个目的地的其它目标共享该退避；它不是远端限流反馈，不伪造 Retry-After。

配置不提供 Key、Cookie、session、代理、脚本、验证码 solver 或登录绕过；用户负责确认部署环境的适用授权。
本次不提交 Sci-Net 请求、不注册账号、不上传文件。运行时不扫描或自动发现镜像；custom 失败后不混入 builtin。
Catalog 保留统一来源、hash、lineage 与资产关系，不存 landing HTML、候选 URL 或逐镜像运行历史。

## 维护与验证

当前 TS 自动化测试使用合成 PDF、临时数据库和 fake/loopback 网络，验证 static fragment 归一化、
目的地安全检查、公共失败的独立 fallback、共享退避和正式 publication。真实探测与下载独立于 Harness，
不得随安装、状态展示、普通测试或 CI 自动执行。

外部入口失效时由维护者重新核验并随版本更新 builtin；用户可以更改 custom 列表。不得通过关闭 TLS、
扩大到私网地址或猜测下载路径来恢复服务。文件发布、存储或合同错误不能降级为“镜像无文件”。
