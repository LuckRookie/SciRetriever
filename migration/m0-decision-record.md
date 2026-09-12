# M0 实施基线决策记录

更新时间：2026-09-12。该记录关闭原始 M0 的基线审查，不授权真实站点访问、用户数据迁移、生产切换或发布。

## 输入与复现

- 基线 revision：`master@e1a33d5986f654f2692d7619dd58448944ec3463`；当前工作树 revision 记录在 `migration/inventory.json`。
- 盘点对象：`src/sciretriever/**/*.py`、`tests/**/*.py`、`scripts/`、CI、配置模型、Provider/Source adapter 和 CLI parser；归档目录不参与映射。
- 运行环境：Node 22.19.0、pnpm 10.32.1、TypeScript 5.9.2、Playwright 1.55.0、Linux x64。
- 数据边界：仅使用 `tests/fixtures/`、系统临时目录和 loopback fixture；不读取个人配置、Catalog、Profile、凭据或文献资产。
- 验收入口：`pnpm quick` 与 `pnpm full`。Python Harness 的历史基线记录保留在 `migration/evidence/baseline/verification.md`，本次不重复运行。

## M0 任务结论

| 任务 | 结论 | 证据与限制 |
| --- | --- | --- |
| T001 | 完成 | `migration/inventory.json` 覆盖 242 个活动 Python 模块、161 个测试文件、8 个公开入口、11 个 Metadata Provider、7 个 Acquisition Source、3 个授权 Provider、23 个 CLI；每项含 target、消费者/任务/测试/证据字段。 |
| T002 | 完成 | ADR 0024 与 `migration/intentional-changes.json` 冻结六主题合同差异；六种 Agent 动作、单一 owner、运行事实与 Literature 事实隔离均明确。 |
| T003 | 部分 | Playwright/Cloak 版本和本地 fixture 路径已锁定；本次没有 operator-managed binary，因此 live bundle 验证保持 `not-run`，macOS/Windows/ARM 不声明支持。 |
| T004 | 完成（Linux 范围） | `migration/native-capabilities.json` 记录 no-follow、fsync、no-clobber、锁、DNS pinned CONNECT 和预算分离；其它平台明确未验证。 |
| T005 | 部分 | 受限 `pdfinfo`/`pdftotext` inspector、超时和资源上限已实现；加密、图片型和压缩炸弹样本仍是明确 follow-up，不扩大当前支持声明。 |
| T006 | 完成（合成 oracle） | `tests/fixtures/compat-v1/` 与 `migration/oracle-manifest.json` 固定 v1 fingerprint、canonical bytes/hash、关系、查询和资产记录；不使用用户库。 |
| T007 | 部分 | `migration/release-matrix.json` 冻结 Linux x64 开发支持、显示依赖、性能观察项和无外网 CI 边界；其它发行平台未验证。 |
| T008 | 完成（有界基线） | 未验证组合均已列为阻断/不支持，不再存在未说明的底层前提；后续任务只能在当前支持矩阵内推进。 |

## 选择与交接

1. 继续使用 Node `node:sqlite`、不可变 FileStore、单一 Application 和鉴权 HTTP + SSE/JPEG；没有证据表明需要新增 native addon、WebSocket 或分布式 scheduler。
2. TypeScript 是当前生产运行路径；Python 源码、历史测试和 Harness 仅作为可追溯材料，退役处置见 `migration/retirement-report.json`。
3. Browser 的复杂 viewer 和跨版本 HTTP Range 重组不伪装为完成；206 分片不能形成完整 Candidate。
4. 真实 Provider、真实站点、真实 MinerU/LLM 和用户数据迁移需要独立授权，不能由 M0 记录替代。

该记录与 `full-migration-roadmap.md` 的 M0 状态一致，并将剩余限制交接给 T003、T005、T027、T036、T059 和 T064。
