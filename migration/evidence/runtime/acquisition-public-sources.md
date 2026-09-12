# TypeScript public acquisition source locators

日期：2026-09-11。

`apps/server/src/acquisition/sources/public.ts` 已建立统一的 TS `AcquisitionSourcePort` 和 `PublicAcquisitionRegistry`，并迁移 direct PDF hint、arXiv、Europe PMC、DOI landing、Unpaywall 五个公共来源的定位逻辑。每个来源只返回经过安全 URL 校验的 `SourceCandidate`；Unpaywall 的公开 API 响应只在 adapter 内解析，email 只用于请求参数，不进入候选或错误文本。registry 对缺失适配器保持明确 `missing-source-adapter`，source locator 不把定位结果冒充下载成功。

直接证据：

- `apps/server/test/acquisition-public-sources.test.ts` 覆盖五个来源的 locator、Unpaywall OA location、重复去重和缺失来源状态；
- `pnpm exec vitest run apps/server/test/acquisition-public-sources.test.ts`：2 tests passed；
- `pnpm quick`：Prettier、ESLint、源码和测试 strict 类型检查通过。

当前边界：HTTP PDF 下载、Network AccessCoordinator/credential grant、Candidate spool 和授权 CORE/Elsevier/Wiley provider
已由 T039 关闭；来源顺序、候选上限、失败/耗尽分类、cooldown 和 assistance 处置由
[`tiered-acquisition-batch.md`](tiered-acquisition-batch.md) 的统一 batch owner 继续承接。真实 Provider 访问仍未授权。
