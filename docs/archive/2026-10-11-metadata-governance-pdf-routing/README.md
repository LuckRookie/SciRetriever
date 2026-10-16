# 元数据名称治理、五层 PDF 获取与 Browser 入口准备

> 归档于 2026-10-11：本计划已完成，保留当时的授权范围、执行记录与验收边界；当前行为以现行架构文档、指南与源码为准。

状态：Completed。Owner：本轮主 Agent。2026-10-11 用户确认提案讨论结束，要求编写计划并开始实施；随后要求使用 ultra 推理强度继续。

## 目标与范围

让已入库文献通过明确且可解释的路线获得 PDF：已有直链及稳定公开地址 → 出版社 API → 聚合/开放获取 API → 公共网站 → Browser。名称差异由规则和显式 AI 辅助维护处理，原始来源记录不被覆盖。Browser 在模型调用前完成程序可以确定的入口准备，同一篇文献不因换入口重置预算；操作空间充裕，重点控制时间和无进展循环。

讨论材料归档到[原提案](../2026-10-11-metadata-governance-and-pdf-routing/proposal.md)。长期合同由 [ADR 0014](../../architecture/decisions/0014-capability-scoped-providers-and-local-credentials.md)、[ADR 0015](../../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[ADR 0023](../../architecture/decisions/0023-generic-browser-agent-executor.md)及 requirements/design/technical 拥有；本计划不替代它们。

包含：

- 五层执行顺序与 cohort 层间屏障、适用性证据、实际访问结果复用。
- PDF 直链候选的通用识别、已知文件角色/版本过滤、一次获取即接纳。
- Provider 名称别名、不同名称汇总、可选 AI 建议、显式接纳与后续复用。
- Browser 有序文章入口、首次模型前恢复、累计预算与生产网络准入接线。
- 用户入口、必要配置、当前指南、离线集成与 Full。

不包含全球期刊/出版社历史关系库、全文身份门、URL 健康数据库、独立治理 daemon、自动执行真实用户库维护，以及当前任务无关的 Web 重设计。

## 授权与工作树基线

- 开发、必要合同修订、非破坏性配置扩展、离线测试和文档已授权。用户本轮明确允许多 Agent；三个 ultra 执行者分范围工作，主 Agent 集成和审查。
- 不执行 commit、push、发布、系统网络配置修改；不读取真实个人配置/凭据，不迁移或修改生产 catalog/资产。
- 真实 Provider/模型/出版社验收与离线 Harness 分开；本轮不因写入测试计划就自动发起新生产任务。
- 起点 HEAD：`b30af24eee78933bc0775cd3ac6b5d0b2ee15439`，分支 `master`。已有大量未提交的发现、字段适配和 PDF 修复；它们是当前实现基线，必须保留，不以 HEAD 覆盖。
- 新日志与合成数据库进入 `/tmp/sciretriever-*`；不新装或升级无关依赖。

## 结果块与依赖

| 块 | 可交付结果 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [01 路线与线索](01-acquisition-routing.md) | 明确五层顺序、一次下载、API 定位证据和入口线索交接 | Accepted 合同修订；名称接口可先用空扩展 | Completed |
| [02 名称维护](02-publisher-governance.md) | 有正式入口的规则汇总、AI 建议与显式别名接纳，不改变文献身份 | Provider 别名合同；与 01 共享候选接口 | Completed |
| [03 Browser 准备](03-browser-preparation.md) | 首次模型前有界入口恢复、一份累计预算、平台边界保持 | 有序入口合同；最终接入 01 | Completed |
| [04 集成验收](04-integration.md) | 对象图、CLI、兼容、文档与 Full 闭环 | 01–03 | Completed |

共享接口先冻结：`AcquisitionStage = direct | publisher-api | general-api | public-web`；来源的认证类别与执行阶段分开；原 `acquisition_tier` 保留兼容。获取请求新增可选 `target_version`。Browser delivery 保留 `start_url`，增加可选完整排序 `start_urls`。名称接口为 `resolvePublisherNames(name, aliases?)`，操作配置为可选 `sources.publisher_aliases`。任何调整须同时通知生产者与消费者。

## 共同不变量与风险

1. 名称匹配与 AI 建议仅产生访问方候选，不证明全文权限；文章级站点、专用标识及实际服务结果仍有效。未知归属不阻断独立可用路线。
2. 保存有效文件并发布后才算获取完成；本地发布失败不重复网络下载；PDF 身份仍标为 unverified。
3. 不新增必经 HEAD/GET 预检；普通 HTTP 403/404 不成为跨 Browser 会话的永久坏链结论。
4. API 凭据仍只发往对应适配器允许的 origin；限流、取消、安全、配置和存储失败保留类别及原有边界。改顺序不自动放宽未约定的错误回退。
5. Browser 每篇任务累计一份预算，所有初始入口和必要恢复共享。5 秒操作节奏、平台串行、实际网络结束后 30 秒冷却保持。
6. 来源记录、文献身份、数据库 schema 和不可变资产格式保持兼容；别名维护属于普通配置，不另建文献事实所有者。
7. 当前 300 秒活跃时间保持；调用/动作默认安全上限提高到 100/200，使时间成为常规主约束。用直接测试验证，不声称真实耗时已改善。

主要风险及归属：阶段重排漏掉原 public 的定位证据（01）；AI 建议污染名称或自动证明授权（02）；开页失败清理导致预算重置、跨平台旁路或在途下载丢失（03）；旧用户配置及测试接线失配（04）。

## 验证与完成标准

定向 Vitest 验证各块用户结果与失败边界，fake/loopback 覆盖真实对象图。总体验收使用：

```bash
pnpm exec vitest run <本轮相关测试文件> --maxWorkers=4
pnpm quick
VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm full
```

所有结果块退出条件、当前指南、来源/调用方复核和 Full 完成后才能声明计划 Completed。模拟模型成功不能证明线上模型、机构版权或出版社实时可用；未做真实验收明确列出。

## 最终结果与恢复

- 四个结果块及所有 Tasks 已完成，生产对象图、CLI、公开导出、配置兼容与文档已同步。
- 最终 Full：210 个测试文件通过、15 个条件跳过；1,606 项通过、39 项条件跳过；Quick 和最终构建通过。环境为 Node 22.19.0、pnpm 10.32.1，完整日志见 `/tmp/sciretriever-routing-full-final-20261011.log`，详细证据见 [04](04-integration.md)。
- 集成审查修复了 DOI 响应重复获取、HTTP 落地误入 HTTPS 下载器、SICI DOI 两套校验不一致、授权 API 地址混入 Browser 起点、版本入口排序，以及初始化观察阻塞捕获交接。它们均有直接回归。
- 未运行线上出版社、真实模型或生产文献库验收；39 项条件跳过不能当成执行过。保留 API 权限/限流/安全失败的原停止策略，不由名称或普通 HTTP 成败推定 Browser 权限。
- 没有修改依赖、数据库 schema 或资产格式。实现验收时尚未提交 Git；后续按用户要求进行的归档与提交见 [04 交付记录](04-integration.md#归档与提交)。恢复时先读本计划和验证记录，不重复迁移或清理用户数据。

## 记录

| 日期 | 变化 |
| --- | --- |
| 2026-10-11 | 提案获准进入计划和实施，建立四个按验收结果划分的块；以 ultra 并行执行、主 Agent 集成 |
| 2026-10-11 | 四块实现、集中审查与 Full 验收完成；标记 Completed，线上效果与条件跳过单独说明 |
| 2026-10-11 | 用户要求归档完成的提案、计划并提交；按元数据、Browser、PDF 获取与文档归档分块纳入 Git |

[上级目录](../README.md) · [项目 README](../../../README.md)
