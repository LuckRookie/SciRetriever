# Acquisition Source TypeScript 迁移矩阵

日期：2026-09-11。任务：T039。

## 完成范围

七个 Python 基线 Source 和三个授权 Provider 已进入 TypeScript Source 边界。相同协议的轻量
adapter 合并在 `acquisition/sources/public.ts`，没有为了文件名一一对应拆出空模块。

| Python 基线 | TypeScript 实现 | 离线证据 |
| --- | --- | --- |
| direct | `DirectPdfSource` | 只消费已保存、媒体类型为 PDF 的 direct-file `AssetHint`；安全 URL、下载大小和 PDF 验收测试 |
| arXiv | `ArxivPdfSource` | canonical arXiv ID/version → PDF locator；坏 ID 正常不适用 |
| Europe PMC | `EuropePmcPdfSource` | PMCID/PMID → 公开 PDF locator；输入顺序和去重 |
| DOI landing | `DoiLandingSource` | canonical DOI landing；受控 HTML 的 citation/link/iframe 静态 PDF locator 解析；没有 locator 时不把 HTML 当 PDF |
| Unpaywall | `UnpaywallSource` | contact 参数、best/other OA location 顺序、direct PDF 与 landing 区分、坏响应失败 |
| configured sci-hub | `ConfiguredSciHubSource` | 只在 Custom 显式选择时启用；有序 custom override 或版本内置 mirror；只形成 DOI landing locator |
| Browser | `BrowserHost`、`BrowserCandidateIntake` | 受控 capture、PDF identity、持久 Candidate、关闭页面和重启恢复；由独立 Browser 配置显式启用 |
| CORE | `CoreAuthorizedPdfClient`、`AuthorizedPdfSource` | 精确 work/output record、Bearer header、正常 miss/状态错误、共享 Candidate 发布门 |
| Elsevier | `ElsevierAuthorizedPdfClient`、`AuthorizedPdfSource` | PII/EID 或已确认 origin 的 DOI；FULL XML MAIN object 顺序、supplement 排除、direct PDF fallback、凭据 header、unsafe XML 拒绝 |
| Wiley | `WileyAuthorizedPdfClient`、`AuthorizedPdfSource` | 已确认 Wiley origin 的 DOI、TDM token header、正常 miss/entitlement、取消 |

## 选择、来源和发布边界

- Auto 的命名 Acquisition Source 固定为 `arxiv, europe-pmc`；direct-file/landing hint 是固有路径。
  Unpaywall、Sci-Hub 和三个授权 API 不会因配置子表或凭据存在而被暗中启用。
- Custom 按用户声明的顺序组装；缺少普通参数或凭据的已选 Source 保留显式 readiness failure。
  Sci-Hub 仍默认关闭，只有 Custom 选择后才使用内置或 custom mirror。
- Elsevier/Wiley 的 DOI 路由需要已保存 AssetHint origin；弱 publisher 文本或凭据存在不能证明原文访问方。
  CORE 只消费精确 `core-work/core-output` 或 `core` observation 的 `work:/output:` record。
- public、authorized 和 Browser 字节都进入同一个 `BrowserTransferCollector` durable Candidate，随后通过
  `CandidateAcceptanceService` 的 current metadata、PDF identity/version 和 CAS 门，再由
  `CandidatePublisher` create-if-absent 发布。Source 不自行修改 Literature 状态。
- Candidate 持久保存真实 `source_name` 和安全 `source_record_id`；最终 Asset provenance 不再把
  public/API 来源统一错误记录为 `browser`。

## 直接验证

主要测试：

```bash
pnpm exec vitest run \
  apps/server/test/source-locator-routing.test.ts \
  apps/server/test/acquisition-public-sources.test.ts \
  apps/server/test/acquisition-authorized.test.ts \
  apps/server/test/candidate-acceptance.test.ts \
  apps/server/test/candidate-publication.test.ts \
  apps/server/test/browser-candidate-journey.test.ts \
  apps/server/test/artifact-reclamation.test.ts
```

测试覆盖 ordered sequential discovery/download、normal miss 与 failure 区分、non-PDF/空/超限、
静态 landing、凭据不出 Source locator、Elsevier object 选择、取消、Candidate 重启恢复，以及 public/API
到 primary Asset 的相同验收和发布路径。Network 的 DNS/IP、redirect credential clearing、预算、响应大小和
取消另由已注册 Network 测试覆盖。

这些结果只证明固定 fixture/loopback 下的协议和生产对象边界。真实 Provider 可用性、配额、entitlement、
站点 HTML 和 Browser 效果未获授权且未执行。

最终 TS Full 验收：

```text
Test Files  107 passed | 3 skipped (110)
Tests       460 passed | 4 skipped (464)
Build       passed
```

完整日志：`/tmp/sciretriever-full-t039-acquisition.log`。跳过项仍是需要显式环境开关的 live/集成场景，
不包含 T039 的离线 Source、Candidate 或发布门验证。
