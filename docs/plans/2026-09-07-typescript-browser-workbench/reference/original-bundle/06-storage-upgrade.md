# 06｜存储兼容、持久任务与安全升级

## 1. 两个不同目标，分开验收

**目标A：语言迁移。** TS正确读写现有v1 Catalog和ArtifactStore，不改变文献身份、关系、字节或schema。

**目标B：产品升级。** 在明确授权的v2 schema中增加任务、尝试、候选交接和恢复机制。

当前schema使用version=1的CHECK约束、完整DDL manifest指纹和完整对象集合检查，且明确没有迁移路径。不能直接添加运行表、修改版本数字或让ORM接管迁移历史。[R10](10-sources.md#r10)[R11](10-sources.md#r11)

## 2. v1兼容实现

从冻结提交导出manifest的原始字符串顺序与UTF-8字节，保存对应fingerprint fixture。TS需要在相同SQLite能力上证明：旧数据库可打开；新建v1库与旧对象集合兼容；索引、FTS5 shadow tables、trigger、STRICT、foreign keys均一致。

不要通过忽略未知表或跳过指纹检查获得“兼容”。也不要因新格式化工具改变DDL拼接空白，就要求用户重建数据库。旧manifest是兼容合同之一，不是可随意排版的代码。[R10](10-sources.md#r10)[R11](10-sources.md#r11)

保留关系化标量/子表/关联表、大内容在文件系统、唯一primary-pdf、不可变observation以及当前ParserResult/Content替换。保留FTS只索引规定内容、不把参考文献或日志全部混入搜索的语义。[R17](10-sources.md#r17)

## 3. DB Worker 与事务

DB Worker持有SQLite连接和提交队列。跨线程发送具名领域操作DTO，例如 `commitPrimaryPdf` 或 `readLiteratureDetail`，不发送任意SQL字符串、任意闭包或数据库handle。

一次详情读取所需多次SELECT在Worker内同一read transaction完成；不能主线程分别请求多张表并假定期间没有更新。一次业务发布在一个短写事务中完成，带expected revision/hash/asset检查。

同步驱动隔离到Worker是为了避免卡住投屏和人工输入；不会改变SQLite同一时刻只有一个写入者。WAL数据库应在适用的本机文件系统上使用，不能把共享网络盘当成多机并发数据库。[W03](10-sources.md#w03)[W05](10-sources.md#w05)[W15](10-sources.md#w15)

保留foreign_keys、WAL、权威写入FULL、有界busy timeout；网络、浏览器、模型与文件准备不进入普通业务事务。[R17](10-sources.md#r17)

## 4. v2运行表建议

以下是schema设计输入，不是已经生成或执行的DDL。运行记录与文献事实物理上可以在同一Catalog中，拥有不同领域写入者；这样可在需要时共同提交，避免额外运行库造成跨库一致性问题。

| 表组 | 最小字段/关系 | 明确不存 |
|---|---|---|
| `execution_jobs` | jobId、目标类型、selector快照、policy快照引用、状态、创建/终止时间 | 页面正文、Cookie、LLM完整思考 |
| `execution_targets` | jobId+ordinal、具体目标ID、选定版本、阶段、处置、nextEligibleAt | 独立文献可用状态副本 |
| `execution_attempts` | attemptId、targetId、起止、阶段、稳定失败/来源、计数预算 | 原始vendor exception、完整签名URL |
| `execution_policy_snapshots` | version、hash、冻结后的规范策略 | secret；可被网页修改的任意文本配置 |
| `browser_workspaces` | workspaceId、profileRef、期望状态、最后安全恢复标记 | 活的Page/CDP handle、可复用控制lease |
| `acquisition_candidates` | candidateId、attemptId、stagingId、hash/size、状态、接收/验收结果 | 公共API可访问的绝对路径、大BLOB |
| `intervention_requests` | requestId、相关目标、请求理由/所需输入、截止处置、完成状态 | 密码、MFA值、全页面截图 |
| `execution_cooldowns` | scope、nextEligibleAt、有限来源证据 | 跨进程网络permit、账号是否有权限的永久判断 |
| `schema_migrations` | version、manifestHash、迁移实现版本、应用时间 | 任意SQL或运行时解析出来的迁移脚本 |

策略快照/selector可用专门、版本化、严格schema的canonical JSON，但这是对现有禁止通用JSON兜底的明确局部修订；不能借此把所有业务对象改为JSON列。需要查询与约束的任务字段仍是普通列。[R17](10-sources.md#r17)

是否需要持久化每一步动作单独成表由恢复需求决定：默认保存关键阶段/派发结果/有界事件，而不是完整event sourcing。可将actionId/outcome-unknown归入attempt子记录；必须能恢复不确定性，但不保存无限浏览历史。

`execution_targets.status`表示任务处置，不能代替Literature的UNREVIEWED/ASSET_READY/CONTENT_READY等已有current-facts推导。一个任务skipped不会写成文献永远不可获取。

## 5. 候选文件与正式资产的交接

```text
浏览器临时文件
   ↓ 完整接收并复制
受控spool（可恢复候选，尚非文献资产）
   ↓ fsync / hash / candidate-ready记录
Acquisition验收
   ↓ 不可变文件发布 + 短SQLite提交
ArtifactStore + primary-pdf关系
   ↓ durable receipt / 对账确认
清理候选暂存
```

正式文件先按内容寻址create-if-absent持久化，再提交关系。目标存在则验证相同字节，不能用会覆盖的普通rename假装no-clobber发布。跨文件系统先复制到目标文件系统的临时文件、同步，再执行该平台可证明的不覆盖发布。[R17](10-sources.md#r17)

文件落盘和SQLite无法跨介质原子提交。崩溃可以留下可对账的无引用文件；不能留下已提交却没有文件的正常关系。清理器跳过活动/待交接候选、被当前parser/content引用的资产和被活动读取固定的hash。

Acquisition提交主资产与更新任务完成，可由Application组装同一个Unit of Work内的两个已确认变更，Storage只执行，不决定文章匹配。即便阶段上暂时分两次提交，恢复必须先查询已提交资产再补任务状态，不能重新下载替代对账。

候选不确定但按策略跳过时，不无限保留。配置有界保留期/总额/清理规则，清理前保留最小诊断；正式原始PDF和可重建中间结果使用不同回收策略。

## 6. 文件安全不能简化成字符串检查

当前设计要求descriptor-relative、no-follow、对象类型、单硬链接、inode、hash/size及原子发布检查；不能只做 `path.resolve().startsWith(root)` 就宣称等价。[R17](10-sources.md#r17)

M0逐平台验证：安全目录逐层打开、路径替换竞态、no-clobber发布、目录fsync、文件读取身份复核、进程崩溃自动释放写锁。Node提供文件操作基础，但不会自动把多次检查变成一个无竞态操作。[W16](10-sources.md#w16)

如果现有合同在某目标平台缺原语，需预编译小型native模块或收窄平台；不得静默放弃保护。当前允许合法可访问的共享目录，不能未经批准改成“目录必须owner-only”然后宣称只是语言迁移。

浏览器临时目录、正式ArtifactStore、用户输入文件与导出目标分开。用户输入只复制不移动；失败不能删除用户原文件；导出覆盖仍需用户显式选择。

## 7. v1 → v2升级步骤

1. 只读 `inspect`：验证当前版本、完整manifest、integrity/foreign-key、路径、空间和所有者状态，输出将发生的变更；没有写操作。
2. 停止或排空写任务，取得catalog同一独占维护锁，拒绝另一个旧/新写进程；冻结会影响备份的清理。
3. 通过SQLite备份机制形成一致快照，并保存资产引用清单、配置备份和校验结果。不能仅复制一个仍有活动WAL的主`.sqlite3`文件。[W15](10-sources.md#w15)
4. 在备份副本先跑迁移与语义核验，验证旧所有业务表/ID/hash/关系保持一致，新任务表为空且约束有效。
5. 对原库执行版本明确的迁移事务。因v1 `CHECK(schema_version=1)`，需正确重建schema identity，而不是一个UPDATE；同步完整v2对象清单和fingerprint。
6. 验证v2完整性、FTS投影、典型查询及artifact可读性；失败时不继续启动写服务。
7. 记录升级receipt；仅在全部成功后启用持久任务功能。旧程序应拒绝v2，而不是降级继续写。

数据库升级命令是拟新增能力，建议提供 `storage inspect / migrate --dry-run / backup / restore-check`，最终名称在CLI合同中确认。生产数据迁移需要用户明确执行或授权，不能在普通查询启动时悄悄迁移。

## 8. 回滚边界

尚未升级schema时，停止TS、关闭浏览器后可回到旧程序，但仍需验证Profile二进制兼容；数据库回滚不等于Profile回滚。

v2尚未发生新业务写入时，可以按演练流程恢复v1一致备份。v2已接收新文献/资产后，直接恢复备份会丢失新增关系；必须保留v2库、资产与manifest，先导出/对账增量，再恢复或做前向修复。**不承诺无损自动降级。**

任何恢复都先在副本验证，不覆盖唯一数据副本。备份对象无引用并不意味着可以立即GC；在恢复窗口内禁止删除其仍需要的原始资产。

## 9. 恢复算法

服务启动先绑定catalog身份和新bootId，使旧控制lease全部无效；核验已提交资产；扫描durable candidates；再收尾遗留attempt。已完成发布只补任务记录，不重复下载；尚在receiving但没有完整文件的尝试标interrupted/retryable，按预算安排，不当作成功。

AI探索现场只恢复目标、政策、历史事实和可安全使用的入口。重新启动页面后重新观察，不重放旧坐标/旧模型输出。nextEligibleAt等冷却保留剩余等待，不恢复旧网络许可或运行中的timer对象。
