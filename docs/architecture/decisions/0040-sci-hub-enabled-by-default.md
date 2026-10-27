# ADR 0040：Sci-Hub 默认启用

类型：决策（ADR）
负责：Sci-Hub 来源在 Auto 中的默认状态
状态：Accepted

- Date: 2026-10-27
- 依据：Owner 明确决定“PDF 下载里面默认应该使用 sci-hub”“默认启用，没啥问题”。
- 部分取代：[ADR 0014](0014-capability-scoped-providers-and-local-credentials.md) 中“Sci-Hub Source 默认关闭；operator 显式启用后”使用镜像的部分；[ADR 0015](0015-publisher-aware-tiered-pdf-acquisition.md) 与 [ADR 0023](0023-generic-browser-agent-executor.md) 中 public-web 只含“显式启用的”Sci-Hub 镜像的限定；[ADR 0022](0022-default-safe-source-selection-and-per-source-limits.md) 中 Sci-Hub 须独立显式启用、凭据或参数不能启用 Sci-Hub 的部分；[ADR 0039](0039-configured-acquisition-auto-and-traces.md) 决定 1 中“镜像不自动启用”。

## 背景

Owner 实际使用中，多数受订阅限制的文献在出版社 API 与公开网页都拿不到，只能交给 Browser Agent，而 Sci-Hub 能覆盖其中相当一部分。原设计把 Sci-Hub 当作需要 operator 显式启用的来源，Auto 默认不用，与 Owner 期望的“默认把能用的都用起来”不一致。

## 决定

1. PDF Acquisition 的 Auto 默认包含 Sci-Hub，使用随版本维护的内置镜像；它位于 public-web 阶段，在 DOI 落地页之后、Browser Agent 之前。
2. Owner 配置了自己的镜像地址时，按 ADR 0014 原有规则完整覆盖内置列表。
3. Custom 仍是精确列表；用户可以在 Custom 中关闭 Sci-Hub。
4. Sci-Hub 的请求继续遵守既有网络准入、单项字节上限、PDF 验收与发布边界；本决定只改变默认启用状态，不放宽任何安全边界。

## 后果

Auto 模式下获取 PDF 会向 Sci-Hub 镜像发出请求，可能减少交给 Browser Agent 的篇数。通过 Sci-Hub 获取全文在许多司法辖区受版权限制；是否使用由 Owner 决定，Owner 已知悉并选择默认启用，需要时可改为 Custom 关闭。实现规则归[文献材料技术篇](../technical/03-literature-materials.md)，用户操作归[PDF 获取指南](../../guides/pdf-acquisition.md)与[配置指南](../../guides/configuration.md)；实施见[计划 17](../../plans/2026-10-27-web-usage-review/README.md) P15。
