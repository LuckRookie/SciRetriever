# 13 · 修缺陷：与重新设计无关、现在就该修的

类型：计划（结果块）
负责：2026-11-13 实现审查中，不随 ADR 0063 改动而消失的缺陷：H1、M1、L4、L5、L7、L9
状态：Pending

## Outcome

- 文件上传与数据分段不再被 5 秒的请求时长截断：在一条经过生产 HTTP 对象图的慢速上传上，超过 16 MiB 的 PDF 能完整入库（H1）。
- 确认导入时，在建文件夹与写外部编号对应之间中断，恢复后不会出现第二个同名文件夹（M1）。
- 进程崩溃留下的暂存文件，按 12.2 的规则被清理（L4）。
- 网页收藏的 PDF 不再带编造的来源地址（L5）。
- JSON 接口按 12.1 的规则接受 Content-Type 参数；换令牌时 Content-Type 不对，按 12.1 返回正确的错误码（L7）。
- 离线迁移在 SQLite 已经自动回滚时，报告原始错误，而不是“没有活动事务”（L9）。

审查报告：`sandbox/reports/2026-11-13-plan20-review/REPORT.md`（不受版本管理）。

## 进入条件

- 13.1、13.5 等 12.1；13.3 等 12.2。
- 13.2、13.4、13.6 不等规格，可以立即开工。
- 13.1 最先做。

## 责任边界

- 负责：后端实施者。
- 拥有：`apps/server/src/workbench/http.ts` 的服务端超时设置，以及受影响路由的读取；`apps/server/src/entry/import-sessions.ts` 的文件夹建立；`apps/server/src/storage/files/` 的暂存清理；`apps/server/src/entry/import-files.ts`、`apps/server/src/acquisition/candidate-acceptance.ts` 中 `web-capture` 的来源记录；`import-http.ts`、`device-http.ts` 的 Content-Type 判断；`apps/server/src/storage/sqlite/import-schema-migration.ts` 的回滚。
- 不改：接口路径与字段（14 的范围）；表结构（本块不改表）；`apps/web/` 与扩展。
- 本块与 14 都改 `import-sessions.ts`。本块先合入，14 在本块的代码上继续。

## Tasks

- [ ] **13.1 上传不受 5 秒请求时长的限制（H1，等 12.1）**
  - 动作：按 12.1 调整 `http.ts:901-902` 的 `requestTimeout`，或为文件字节、数据分段与 MCP 请求正文另设规则；按 12.1 加上“长时间没有收到数据就断开”的保护。
  - 输出：受影响的路由清单与各自的超时，记入本块的证据。
  - 验收：
    - 新增一条真正经过 HTTP 的测试，使用生产的 `startWorkbenchHttp` 对象图与设备令牌：以受控的低速发送一个大于 16 MiB 的合成 PDF，总耗时超过 5 秒加一个连接检查周期，结果是 `uploaded`，主 PDF 的大小与 sha256 正确；
    - 同样的慢速数据分段（`/data`）成功；
    - 中途停止发送超过 12.1 规定的间隔后，连接被断开，暂存文件被删除，文件仍为待交；
    - 其他路由的超时行为不变，现有测试通过。
    - 测试可以缩短连接检查周期以控制时长，但发送速率与总耗时必须真实；用替身代替 HTTP 不算数。
- [ ] **13.2 文件夹只建一次（M1）**
  - 动作：在 `ensureFolder`（`import-sessions.ts:877-928`）中，让“建文件夹”与“写 `group` 映射”成为一次原子写入；或者在恢复时，按映射键与父级认领上次已经建好、但还没有映射的文件夹。根文件夹、分组与标签文件夹都适用。具体做法交总设计师核对后再写。
  - 输出：做法说明，记入证据。
  - 验收：在 `import-sessions.test.ts` 中新增故障注入测试：在 `source:<分组>` 的映射写入前抛错，重开应用并 `sweep()`，最后只有一个同名文件夹，成员都在其中，批次完成。复现方法参照审查探针 B（`sandbox/reports/2026-11-13-plan20-review/scratch/review-probe.test.ts`）。
- [ ] **13.3 崩溃后的暂存文件清理（L4，等 12.2）**
  - 动作：按 12.2 实现清理。
  - 输出：清理的位置、时机，以及判断文件无主的依据。
  - 验收：
    - 人为留下一个陈旧的 `stage-*.tmp`，重启后被清理；
    - 另一个进程正在写的暂存文件不被删除（用两个 Application 实例模拟）；
    - 清理不触及 `.candidates/` 中仍有记录的候选文件与已发布的文件。
- [ ] **13.4 网页收藏的 PDF 来源记录（L5）**
  - 动作：`web-capture` 上传的 PDF，不再把 `https://sciretriever.local/web-capture` 写成来源地址，`source_record_id` 也不再固定为 `"pdf"`。在 12.14 定下真实地址的记录方式之前，来源地址留空。
  - 验收：`capture-backend.test.ts` 断言收藏上传的资产来源里没有编造的地址；`import` 与 `manual-pdf` 来源不受影响。
- [ ] **13.5 Content-Type 参数（L7，等 12.1）**
  - 动作：导入、收藏、换令牌与设备管理统一按 12.1 判断 Content-Type。换令牌时 Content-Type 不对，按 12.1 返回错误码。
  - 验收：
    - 带 `charset=utf-8` 的请求按 12.1 的规则被接受或拒绝；
    - 换令牌时 Content-Type 不对，得到 12.1 规定的码，不再是 `device-pairing-invalid`；
    - 限流计数照 01 §2.4.1 不变。
- [ ] **13.6 迁移回滚不掩盖原始错误（L9）**
  - 动作：`import-schema-migration.ts:82-85` 只在仍有活动事务时执行 `ROLLBACK`，并且总是抛出原始错误。同样写法的其他离线迁移（`intake-schema-migration.ts` 等）照此检查，只在确有同样问题时修。
  - 验收：在 `import-schema-migration.test.ts` 中注入一个使事务提前结束的失败，抛出的是原始错误，库文件逐字节不变。

## 集成与影响

- 服务端的超时规则改变，影响所有经 4174 的长请求。
- 网页收藏的资产来源记录改变，只影响新写入的记录。
- 不改公开路径、字段与表结构。

## 验证

- 定向测试：`pnpm exec vitest run apps/server/test/import-sessions.test.ts apps/server/test/import-http.test.ts apps/server/test/capture-backend.test.ts apps/server/test/device-connections.test.ts apps/server/test/import-schema-migration.test.ts`，加上 13.1 新增的测试文件。
- `pnpm quick`。
- 未覆盖：经真实 SSH 隧道的上传。它在 11 的 M1 试用中验证。

## 证据

每个 Task 记录：提交号、命令、结果，以及 13.1 测试的实际耗时与速率。

## 退出条件

13.1–13.6 都已勾选。14 可以在本块的代码上开工。

## 恢复与交接

- 13.1 若发现 Node 的超时机制无法按路由区分，停下，把可选做法写进证据交总设计师，不自行放宽全局超时。
- 13.2 的两种做法都要改动现有写入顺序；交总设计师核对之前，不合入。
