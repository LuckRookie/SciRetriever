# 执行顺序与恢复路径

本文件只说明真实依赖、汇合点和恢复顺序。逐项动作、checkbox、状态、直接测试和证据以所属块 `Tasks` 为准；
[任务索引](task-ledger.md)只提供导航。历史研究档案不参与执行。

## 块级主链

```text
Block 01 BASELINE-ACCEPTANCE
  └─ Block 02 RUNTIME-FOUNDATION-ACCEPTANCE
       ├─ Block 03 BROWSER-ACQUISITION-ACCEPTANCE
       │    ├─ Candidate/evidence ───────────────┐
       │    └─ Workbench endpoint/streams ──┐    │
       └─ v1 repositories/Application ──────┼────┤
                                             │    ▼
                                             │  Block 04 business R3
                                             │    │
                                             ▼    ▼
                                       Block 05 PERSISTENT-SERVICE-ACCEPTANCE
                                             │
                                             ▼
                                       Block 06 R5 / authorization package
```

Block 04 需要 Block 02 的 v1 基础和 Block 03 的 Candidate 合同；Block 05 同时需要 Block 03 的工作台流与
Block 04 的业务 Application/Literature publication。Block 06 只能在前五块全部退出后执行。

## Block 01 内部顺序

1. 固定 baseline 后补齐模块、公开入口、Metadata、Acquisition、CLI、Configuration 和测试 inventory。
2. `INVENTORY-TRACEABILITY` 汇合 consumer、owner、目标 Task、直接测试、证据和 disposition；任何空项阻断退出。
3. 分别完成 Browser runtime、平台文件安全、PDF 引擎、威胁模型和支持平台 spike；环境发现不代替组合验证。
4. 形成 `RUNTIME-SELECTION` 和 `MIGRATION-DECISIONS`，核对 ADR 0024 及相关 Accepted 合同的有效状态。
5. 核对 fixture、工具链与 contracts 后执行 `MIGRATION-CONTRACTS`、`BASELINE-ACCEPTANCE`。

当前恢复点是 `INVENTORY-MODULES`。本轮已按用户要求停在开始实现前。

## Block 02 内部顺序

1. Configuration parser/credential → Network URL/DNS/connection/redirect → request budget 与 Browser port。
2. FileStore stage/write/read/handoff → publication/locking → configuration publication。
3. SQLite Worker/snapshot → 所有 v1 repositories → atomic publication。
4. Agents runtime 与三个协议 adapter → logging →唯一 Application composition/lifecycle。
5. `RUNTIME-FOUNDATION-ACCEPTANCE` 汇合 R3；已勾选的局部基础切片不能绕过重开的 Task 和新增 repository。

## Block 03 内部顺序

1. Host → 逐事件 egress → crash recovery → Observation/Action。
2. Screen source/stream → workbench endpoint/Web/input/unsupported input → control 汇合。
3. Transfer dispatch → response forms → Range/ETag → attribution → deduplication → bounded drain → Collector。
4. Policy contract/assistance/privacy → execution policy/loop/diagnostics。
5. PDF acceptance/text evidence → identity/version verdict → durable Candidate receipt。
6. 逐个来源与授权 adapter → acquisition route →真实 Chromium loopback journey →块级 acceptance。

工作台先于 Agent 自动化闭环。观察预算耗尽返回 `partial + loading`；不得等待 `networkidle`。Candidate 只交给
Block 04，不在本块写正式 Literature facts。

## Block 04 内部顺序

1. 11 个 Metadata adapter 串行完成直接 parity，再由 `META-DISPATCH` 汇合。
2. Literature identity/current facts → `LITERATURE-ASSET-PUBLICATION` → references/delete。
3. Discovery、metadata/PDF import、metadata/artifact export。
4. MinerU handoff → metadata/content/reference analysis → library query。
5. 公共 Application → discovery/completion/library/exchange CLI → model catalog/probe/editor/config CLI。
6. 业务 R3 只交付业务入口和正式文献发布，不包含 execution schema 或服务完成结论。

## Block 05 内部顺序

1. execution schema inspect → backup → migration → rollback。
2. job/attempt/event repositories → Candidate ACK。
3. recoverable queue → workspace scheduling → assistance → crash recovery。
4. authentication → HTTP API → event/screen stream → CLI/daemon → service composition。
5. persistent service journey → v1/v2 copy recovery → `PERSISTENT-SERVICE-ACCEPTANCE`。

Schema 只在合成库或明确副本上改变。Candidate ACK 只记录交接，不成为 Literature 写入 owner。

## Block 06 内部顺序

1. TS gates/CI → package build/content → platform installation → package installation。
2. clean environment journey →完整 offline journey。
3. data backup/migration/rollback → Profile rollback → recovery 汇合。
4. performance → backpressure → security → live-site status。
5. documentation → Python retirement report → cutover drill → readiness report → R5 review。
6. 最后向用户提交精确 `CUTOVER-AUTHORIZATION` 包；未获授权时不执行生产、发布、Git 或退役动作。

## 变更与失败路由

- 公开合同、长期 owner 或产品边界变化：回到 requirements/ADR 和 Block 01，不在下游打补丁。
- v1 bytes/hash/schema/query 差异：回到 Block 01/02。
- Browser/Transfer/Policy/Candidate 缺陷：回到 Block 03。
- Literature 正式资产或业务 parity 缺陷：回到 Block 04。
- schema/queue/recovery/auth/service 缺陷：回到 Block 05。
- package/platform/journey/recovery/security/doc finding：Block 06 路由到真实 owner 后重跑受影响最终门。

每项仍按“预检 → 最小完整切片 → 直接测试 → diff/合同审查 → 脱敏证据 → 更新状态”执行。任务文件编号不传播
到测试、suite、源码或证据名称。
