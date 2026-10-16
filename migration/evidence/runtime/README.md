# 运行模块迁移证据

本目录保存 各 TypeScript 模块及联合旅程的历史实现证据。

## 内容入口

- [acquisition-public-sources.md](acquisition-public-sources.md)：TypeScript public acquisition source locators
- [acquisition-source-matrix.md](acquisition-source-matrix.md)：Acquisition Source TypeScript 迁移矩阵
- [agents-runtime.md](agents-runtime.md)：Agents runtime evidence
- [analysis-execution.md](analysis-execution.md)：Analysis 两阶段执行与模型协议
- [analysis-typescript.md](analysis-typescript.md)：TypeScript Analysis 运行证据
- [anthropic-adapter.md](anthropic-adapter.md)：Anthropic adapter evidence
- [application-assembly.md](application-assembly.md)：Application assembly evidence
- [application-lifecycle.md](application-lifecycle.md)：Application lifecycle evidence
- [artifact-reclamation.md](artifact-reclamation.md)：无引用文件的受控回收
- [artifact-recovery.md](artifact-recovery.md)：NoUsableContent 清理的重启恢复
- [asset-repository.md](asset-repository.md)：Asset repository evidence
- [bibliography-import-typescript.md](bibliography-import-typescript.md)：TypeScript bibliography import codecs
- [browser-mineru-analysis-journey.md](browser-mineru-analysis-journey.md)：Browser → MinerU → Analysis 联合旅程
- [candidate-abandonment.md](candidate-abandonment.md)：Candidate durable abandon/reject 闭环
- [candidate-recovery.md](candidate-recovery.md)：Candidate 与发布回执恢复
- [catalog-write-admission.md](catalog-write-admission.md)：Catalog 写入准入与发布窗口
- [chat-adapter.md](chat-adapter.md)：OpenAI Chat adapter evidence
- [cli-typescript.md](cli-typescript.md)：TypeScript CLI 证据
- [configuration-boundary.md](configuration-boundary.md)：CONFIG-PARSER 验收证据
- [configuration-owner-bridge.md](configuration-owner-bridge.md)：Python 配置 owner 的 typed bridge（历史迁移证据）
- [configuration-publication.md](configuration-publication.md)：Configuration publication evidence
- [configuration-typescript-owner.md](configuration-typescript-owner.md)：TypeScript Configuration/Credential Owner
- [content-acceptance.md](content-acceptance.md)：Literature 内容接纳与完整事务
- [content-analysis-entry.md](content-analysis-entry.md)：Entry 分析接纳入口与精确输入判定
- [credential-origin.md](credential-origin.md)：CONFIG-CREDENTIAL 验收证据
- [crossref-compatibility.md](crossref-compatibility.md)：Crossref 代表性兼容切片
- [discovery-citation-typescript.md](discovery-citation-typescript.md)：Citation Discovery TypeScript slice
- [discovery-import-typescript.md](discovery-import-typescript.md)：Discovery 与 Import TypeScript 迁移证据
- [discovery-topic-typescript.md](discovery-topic-typescript.md)：Topic Discovery TypeScript slice
- [durable-execution-service.md](durable-execution-service.md)：持久任务执行服务证据
- [file-locking.md](file-locking.md)：File locking evidence
- [file-publication.md](file-publication.md)：File publication evidence
- [file-staging-lifecycle.md](file-staging-lifecycle.md)：File staging lifecycle evidence
- [file-staging-reader.md](file-staging-reader.md)：File staging write evidence
- [file-staging-write.md](file-staging-write.md)：File staging write evidence
- [immutable-file-store.md](immutable-file-store.md)：FILE-STAGING 执行与审查记录
- [immutable-publication.md](immutable-publication.md)：File publication evidence
- [installed-package-smoke.md](installed-package-smoke.md)：已打包模块的本地安装与启动 smoke
- [installed-web-assets.md](installed-web-assets.md)：安装包 Web 静态资产边界
- [library-query-export-typescript.md](library-query-export-typescript.md)：TypeScript Library Query 与原子导出证据
- [literature-artifact.md](literature-artifact.md)：Literature artifact 读取与导出
- [literature-completion.md](literature-completion.md)：有界 Candidate → Literature 内容补全
- [literature-detail.md](literature-detail.md)：LiteratureDetail 与内容合同
- [literature-identity-index.md](literature-identity-index.md)：Literature 身份索引化容量证据
- [literature-identity-publication.md](literature-identity-publication.md)：Literature 身份、元数据与原子发布矩阵
- [literature-query.md](literature-query.md)：Literature 状态与搜索入口
- [logging-redaction.md](logging-redaction.md)：Logging redaction evidence
- [metadata-arxiv-rest.md](metadata-arxiv-rest.md)：TypeScript arXiv Metadata adapter
- [metadata-commercial-rest.md](metadata-commercial-rest.md)：CORE、Springer、Elsevier 与 Web of Science REST adapters
- [metadata-crossref-rest.md](metadata-crossref-rest.md)：TypeScript Crossref REST adapter
- [metadata-datacite-rest.md](metadata-datacite-rest.md)：TypeScript DataCite REST adapter
- [metadata-europe-pmc-rest.md](metadata-europe-pmc-rest.md)：TypeScript Europe PMC REST adapter
- [metadata-openalex-rest.md](metadata-openalex-rest.md)：TypeScript OpenAlex REST adapter
- [metadata-opencitations-rest.md](metadata-opencitations-rest.md)：OpenCitations REST adapter
- [metadata-provider-matrix.md](metadata-provider-matrix.md)：Metadata Provider TypeScript 迁移矩阵
- [metadata-semantic-scholar-rest.md](metadata-semantic-scholar-rest.md)：TypeScript Semantic Scholar REST adapter
- [metadata-typescript-core.md](metadata-typescript-core.md)：TypeScript Metadata core
- [mineru-execution.md](mineru-execution.md)：MinerU 实际执行适配与受控 loopback 旅程（历史 bridge 证据）
- [mineru-typescript.md](mineru-typescript.md)：TypeScript MinerU backend 运行证据
- [model-loopback.md](model-loopback.md)：配置驱动的模型 loopback 组装
- [network-admission.md](network-admission.md)：NETWORK-ADMISSION 执行与审查记录
- [network-body-limits.md](network-body-limits.md)：Network body limit evidence
- [network-budget.md](network-budget.md)：NETWORK-BUDGET 执行与审查记录
- [network-cancellation.md](network-cancellation.md)：Network cancellation evidence
- [network-connection.md](network-connection.md)：Network connection evidence
- [network-permit.md](network-permit.md)：Network permit evidence
- [network-redirect-credentials.md](network-redirect-credentials.md)：Network redirect evidence
- [network-resolution-policy.md](network-resolution-policy.md)：Network resolution policy evidence
- [network-retry-after.md](network-retry-after.md)：Retry-After evidence
- [network-url-policy.md](network-url-policy.md)：Network URL policy evidence
- [no-usable-content-cleanup.md](no-usable-content-cleanup.md)：NoUsableContent 的当前事实清理事务
- [no-usable-content-entry.md](no-usable-content-entry.md)：NoUsableContent 的执行记录清理与 Entry 编排
- [observation-repository.md](observation-repository.md)：Observation repository evidence
- [parsing-publication.md](parsing-publication.md)：正式 PDF 到 ParserResult 的准备与发布
- [portable-package.md](portable-package.md)：Portable package 与安装后 smoke
- [product-loopback-journey.md](product-loopback-journey.md)：Browser 到内容查询的联合 loopback 旅程
- [provider-compatibility-followups.md](provider-compatibility-followups.md)：Metadata Provider 后续兼容清单
- [python-retirement.md](python-retirement.md)：Python 生产入口退役记录
- [reference-repository.md](reference-repository.md)：Reference repository evidence
- [responses-adapter.md](responses-adapter.md)：OpenAI Responses adapter evidence
- [sqlite-compatibility.md](sqlite-compatibility.md)：SQLite Worker and v1 schema evidence
- [tiered-acquisition-batch.md](tiered-acquisition-batch.md)：TypeScript 分层 Acquisition 混合批次证据
- [v2-migration.md](v2-migration.md)：v1 → v2 Catalog 迁移证据
- [workbench-library.md](workbench-library.md)：Web 文献库查询、详情与正式文件下载

## 放置边界

历史结果只对应记录中的版本与环境，不代表当前生产可达性；新测试材料放本机 sandbox，长期结论提炼到所属架构或兼容说明。

[上级目录](../README.md) · [项目 README](../../../README.md)
