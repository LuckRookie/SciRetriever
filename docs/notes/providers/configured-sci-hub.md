# Configured Sci-Hub

- 外部事实最后核对：2026-10-10（Asia/Shanghai），用户明确授权的低频真实调查与下载验证。
- 当前选择键：Acquisition `sci-hub`；不提供 Metadata 或引用发现能力。
- 默认关闭；用户启用后使用版本维护的镜像列表；custom `urls` 完整覆盖 builtin。
- 当前内置入口：`https://sci-hub.ru`。
- 生产实现：[定义](../../../apps/server/src/providers/sci-hub/definition.ts)、[Source](../../../apps/server/src/providers/sci-hub/acquisition.ts)、[locator](../../../apps/server/src/providers/sci-hub/locators.ts)。

## 当前外部观察与证据边界

2026-10-10 的真实请求确认如下；这些是当前环境的观察，不是长期服务合同或官方 SLA。

| 入口 | 实际观察 | 当前处理 |
| --- | --- | --- |
| `sci-hub.ru/10.1016/s0254-0584(01)00333-9` | 返回 200 Sci-Hub landing，未转到 Sci-Net | 继续通用静态 PDF 获取 |
| `sci-hub.ru/10.1021/acs.chemmater.4c00597` | HTTP 302，Location 指向同 DOI 的 `sci-net.xyz` 页面 | 由共享 Network 重新检查重定向目的地，再处理 landing |
| `sci-hub.ru/10.1021/acsomega.5c11075` | 同样转到 Sci-Net；本次返回 200、显示 uploaded | 按页面实际 PDF 声明处理，不把重定向视为拒绝 |
| `sci-net.xyz/` | 首页自述为论文请求与共享平台，已上传文件可不注册访问 | 仅记录页面声明，不新增账号、上传或请求表单自动化 |
| `sci-hub.kr/` 与两个新旧 DOI 入口 | 均为同一份 610 字节的 Science Hub 广告占位 HTML，含广告 iframe，没有 DOI 查询表单或 PDF 声明 | 从 builtin 移除；不改写用户 custom 列表 |

`.kr` 在 2026-08-28 的根页面核验中曾呈现 Sci-Hub DOI 表单，因而进入早期 builtin。
本次三个路径返回同一 hash 的占位页，只能证明它当前在本环境不能充当有效镜像，不能据此确认域名被接管的原因。
不会自动加入搜索到的其它域名，也不会把 Sci-Net 硬编码为新的内置镜像。

此前批量日志中，Sci-Net 的 43 次响应均为 502；本次同类入口已恢复到 200。
新的 302 Location 证据确认跳转由远端发出，并非应用猜出的域名。没有足够证据把早先 502
归因于账号拒绝、订阅权限不足、请求过快或 IP 封禁；网关更深层故障原因不在客户端日志内。

Sci-Net 样本中存在带引号的 `iframe src`，PDF URL 尾部包含 `#view=FitH&navpanes=0`。
旧共享静态解析器提取了链接，但 `safeLocator` 拒绝 fragment，导致文件被遗漏。
当前在静态链接进入 locator 检查前删除仅供阅读器显示的 fragment，再保留原 path/query、
origin、DNS、重定向和文件检查。没有为 Sci-Net 新建 selector、页面程序或文章特例。

真实验证与修复结果见[本次记录](../sci-hub-routing-and-public-fallback-2026-10-10.md)。
原始请求记录位于 `/tmp/sciretriever-scihub-routing-20261010-ULmT6B/`，未提交原始页面或 PDF。

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
