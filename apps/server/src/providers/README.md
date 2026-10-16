# 文献供应商适配器

按供应商找代码：进入对应目录即可查看服务定义、支持的能力和协议实现。

```text
providers/
  contracts.ts           # 静态服务/能力合同与共同默认政策
  registry.ts            # 汇总各家定义，查询能力和访问政策
  publisher-names.ts     # 就近别名与用户扩展的共享名称匹配
  acquisition.ts         # 授权 PDF 适配器的路由注册
  shared/                # 无供应商专有分支的协议帮助
  elsevier/
    definition.ts        # URL、阶段、出版社别名、凭据要求、覆盖证据、产品额度
    metadata.ts          # Scopus 搜索、Abstract 查询及记录转换
    acquisition.ts       # Article/Object PDF 获取与定位
  wiley/
    definition.ts
    acquisition.ts       # Wiley TDM PDF；没有元数据搜索能力
  arxiv/
    definition.ts
    metadata.ts
    acquisition.ts
    locators.ts          # arXiv ID 到 PDF 地址
```

## 目录对应能力

| 目录 | 元数据 | PDF | 其它文件/说明 |
| --- | --- | --- | --- |
| `arxiv/` | 搜索、查询 | 直接定位 | `locators.ts` |
| `core/` | 搜索、查询、引用 | 授权 API | 两种能力共享 CORE 额度 |
| `crossref/` | 搜索、查询 | 提供线索 | `record.ts`：记录转换 |
| `datacite/` | 搜索、查询、引用 | 提供线索 | 不把线索包装成独立 PDF API |
| `elsevier/` | 搜索、查询 | 授权 API | 多个 API 产品分别声明额度 |
| `europe-pmc/` | 搜索、查询、引用 | PMCID 定位 | `locators.ts` |
| `openalex/` | 搜索、查询、引用 | 提供线索 | Key 通过私密 query 注入 |
| `opencitations/` | 查询、引用 | 无 | 不参加主题搜索 |
| `sci-hub/` | 无 | 镜像页面定位 | `locators.ts`，builtin 镜像在 definition |
| `semantic-scholar/` | 搜索、查询、引用 | 提供线索 | 可选 Key |
| `springer/` | 搜索、查询 | 提供线索 | 没有独立主 PDF API |
| `unpaywall/` | 无 | OA 位置查询 | `locators.ts` |
| `web-of-science/` | 依产品支持搜索、查询、引用 | 无 | Starter/Expanded 定义就近维护 |
| `wiley/` | 无 | TDM API | 只处理具备 Wiley 访问证据的目标 |
| `plos/` | 无独立 adapter | 通用 HTTP | 仅声明已有网页访问政策 |

## 接口与责任

- 各家 `metadata.ts` 实现 `metadata/ports.ts` 的搜索、查询、引用窄接口；`acquisition.ts` 实现 `acquisition/ports.ts` 的来源/授权客户端接口。只实现支持的能力，不制造空方法。
- `definition.ts` 保存静态外部事实，包括独立于认证类别的 `acquisitionStage` 和已知 `publisherAliases`，不保存真实 Key、Cookie、用户配置或运行时额度。适配器直接使用本目录定义；registry 汇总这些定义，不维护第二份规则。
- `shared/` 保存通用 metadata transport/记录帮助、授权 PDF 响应合同和 locator 帮助。实际厂商 JSON/XML 解析、URL 规则和认证协议留在对应供应商目录。
- `shared/metadata-values.ts` 统一可选字段的规范化与局部舍弃；文献身份、provenance、响应与分页协议仍严格。各家保留显式字段映射，规则见供应商治理。
- 名称解析按明确别名和确定性规范化提出候选；用户扩展保存在普通配置 `sources.publisher_aliases`，显式维护/AI 建议与接纳保留原文、冲突和 provenance，不证明文章访问权或覆盖来源。
- 五层顺序为 direct → publisher-api → general-api → public-web → browser。arXiv/Europe PMC 属于 direct，Elsevier/Wiley 属于 publisher-api，CORE/Unpaywall 属于 general-api，Sci-Hub 属于 public-web；Direct/DOI landing 与 Browser 继续由各自 owner 负责。
- 搜索操作、身份、PDF 验证入库、Browser 控制与 Network 调度仍在原业务模块。Provider 不能自行写库或实现私有限流器。
- `metadata.ts` 中保留公开的旧 decoder-shell 类以维持包根 API 兼容；生产组装使用实际 REST/Atom adapter。旧内部目录已移除，调用方直接引用当前路径。

新增供应商时，从对应 capability 的现有适配器入手；维护自己的 definition、实现和直接测试，然后在注册/生产组装入口接线。详细规范见[供应商治理](../../../../docs/development/provider-governance.md)。

## 子目录导航

- [arxiv/](arxiv/README.md)：arXiv 适配器。
- [core/](core/README.md)：CORE 适配器。
- [crossref/](crossref/README.md)：Crossref 适配器。
- [datacite/](datacite/README.md)：DataCite 适配器。
- [elsevier/](elsevier/README.md)：Elsevier 适配器。
- [europe-pmc/](europe-pmc/README.md)：Europe PMC 适配器。
- [openalex/](openalex/README.md)：OpenAlex 适配器。
- [opencitations/](opencitations/README.md)：OpenCitations 适配器。
- [plos/](plos/README.md)：PLOS 适配器。
- [sci-hub/](sci-hub/README.md)：Configured Sci-Hub 适配器。
- [semantic-scholar/](semantic-scholar/README.md)：Semantic Scholar 适配器。
- [shared/](shared/README.md)：供应商共享协议帮助。
- [springer/](springer/README.md)：Springer Nature 适配器。
- [unpaywall/](unpaywall/README.md)：Unpaywall 适配器。
- [web-of-science/](web-of-science/README.md)：Web of Science 适配器。
- [wiley/](wiley/README.md)：Wiley 适配器。

[上级目录](../README.md) · [项目 README](../../../../README.md)
