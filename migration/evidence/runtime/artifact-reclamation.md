# 无引用文件的受控回收

2026-09-10。阶段 05-05，接续 [catalog 清理](no-usable-content-cleanup.md) 与
[共同写入准入](catalog-write-admission.md)。

## 入口与引用检查

Application 提供 `app.artifactReclaimer.reclaim(retired_artifacts, options?)`，返回相对路径列表
`deleted / preserved / missing`。输入为已知失效对象的 reference 与 ArtifactRef；不遍历用户目录、不删除
catalog 技术行。只接受配置 artifact root 下 `objects/`、`.objects/`、`.candidates/` 范围的规范相对引用。
每次最多 10,000 个显式描述符，每个对象最多 512 MiB，逐块校验，内存不承载完整文件。

回收与 Application 所有正式发布共用一个 `CatalogWriteAdmission`。在锁内，SQL snapshot 同时检查
artifact_objects、Asset、Parser/资源和 content 的路径引用，再读取 execution Candidate/receipt。
Candidate、intent、result 均通过实际合同解析并核对相互身份；execution schema 残缺、记录损坏或关系不一致
时拒绝回收。正式登记即保留；Candidate 同 hash、receipt 同目标或同 hash 也保留，包括尚未提交的 receipt。
因此旧 retired 列表不构成删除当前新登记文件的授权。

## 文件删除与重试

Linux 下逐级 no-follow 打开目录，操作使用持有的 `/proc/self/fd` 路径。普通文件必须只有一个 hardlink，
大小/hash 与描述符一致。校验前后核对 inode、设备、大小、mtime、ctime；根目录至父目录的实际绑定在
修改前再次确认。

原文件同目录下使用确定性的 `.reclaim-<descriptor-hash>/` 隔离目录。先持久化 `identity.json`，记录相对
reference、ArtifactRef 及设备/inode/大小/mtime，再把原名字移入其中的 `object`。已有隔离对象不被覆盖。
移动后通过仍然持有的原文件 descriptor 复核 hash 和身份，以及隔离目录的当前绑定，确认后才 unlink。
新占用原路径的文件不会被 unlink；移动前被替换的文件保留在隔离目录作为冲突证据。

文件、目录分别 fsync。三个中断点（完成验证、移入隔离、unlink 后）均可在重新启动 Application 后以
同一描述符列表重试。进行中保留小型 identity marker，它用于识别被替换的 inode；成功后删除 marker 和
空隔离目录，不形成长期删除历史。重复调用对已不存在的对象返回 missing。marker 删除后残留空目录也可重试清理。

操作逐对象完成，失败不会回滚已完成的删除，也不撤销此前 catalog 的有效清理；调用方可重试原列表。
这不是任意同 UID 恶意进程持续篡改目录时的隔离机制；依赖产品发布者遵守共同准入，目录仅由 operator 管理。

## 直接验证

`artifact-reclamation.test.ts` 17 项：

- 实际 PDF、Parser、content 清理后回收四个文件，metadata 保留，重启后重放返回 missing。
- 三个中断点后的持久标记与重新启动重试。
- 回收前重新登记 Asset、Candidate 同 hash、pending receipt 同目标不同 hash 均保留。
- 损坏 Candidate/receipt 拒绝回收并保留原文件。
- hash、symlink、hardlink 拒绝；移动前替换保留隔离证据，移动后新原路径保留。
- 父目录、隔离目录替换均拒绝删除。
- 取消和越界路径拒绝；已准入的发布完成 SQL 登记后，排队回收才判断是否保留。

与 catalog 清理和写入准入共 35 项直接测试通过。未运行 Python Quick/Full/unittest；沿用合成临时 home、
已有 Python Parser 规则 bridge 与 Vitest 的离线 fixture。

## 首阶段边界与 Deferred

低层入口消费显式描述符；[NoUsableContent 重启恢复](artifact-recovery.md)已持久化本次清理的技术清单，
不再要求调用者跨重启保存列表。对其它历史孤立文件的通用扫描缺少 manifest/namespace/reference 边界，
存在误删风险，因此明确 Deferred。
成功删除会回收隔离 marker；Candidate/receipt 的精确失效与 Entry 编排已由
[NoUsableContent Entry](no-usable-content-entry.md)接入，自动恢复与有界后续候选重试旅程已经完成。

没有新增 npm 依赖、catalog schema、生产数据迁移或 Git 提交。

## 全量验收

`SCIRETRIEVER_CLOAK_BUNDLE=<本机已安装 bundle> pnpm full` 成功退出：74 个测试文件、304 项测试通过；
Quick、实际 Cloak loopback、离线安装和最终 build 均通过。日志 `/tmp/sciretriever-reclamation-full.log`。
`git diff --check` 通过；新增源码和测试只使用合成临时数据，没有修改依赖锁文件或执行 Git 提交。
