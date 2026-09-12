# NoUsableContent 清理的重启恢复

2026-09-10。阶段 05-05，在[协调清理](no-usable-content-entry.md)与[受控文件回收](artifact-reclamation.md)
之间补齐进程退出时的文件清单丢失窗口。

## 当前行为

`ArtifactRecovery` 使用与所有发布相同的 CatalogWriteAdmission。Entry 在正式清理 SQL 提交前，将本次
可能失去引用的正式对象和待删 Candidate 文件描述符写入 artifact root 的 `.reclamation/<sha256>.json`。
列表由当前闭合 snapshot 与 Acquisition 的精确 Candidate 决定形成，不扫描用户材料。SQL 仍以完整 token
执行 CAS；清单写入不替代任何业务决定。

清单仅包含技术格式版本、canonical catalog path 的 hash 绑定、相对 reference 与 ArtifactRef。不保存
Literature ID、Candidate ID、receipt、来源 URL、无效决定或用户配置。最多 10,000 个唯一对象、16 MiB
清单；规范化排序、合同解析和整个 JSON 的内容 hash 共同核验，不能通过只重命名文件改变内容身份。
不修改 catalog schema 或新增永久无效记录。

Application 在完成 schema 初始化后、返回可用对象前调用 `artifactRecovery.recover()`。调用方也可显式
调用该入口重试。恢复重新取得共同准入，读取已持久化清单，让 File Reclaimer 逐项核对当前正式和
execution 引用，再按实际状态回收。完成后删除清单并 fsync 所在目录。

- 清单已持久化但 SQL 未提交：当前正式/执行引用仍在，保留文件并移除已无待处理事项的清单。
- SQL 已提交但回收未开始：按当前无引用事实继续回收，调用方不必记住旧描述符。
- 部分文件已删除，或已 unlink 但隔离 marker 尚在：由既有 descriptor/marker 协议幂等继续。
- 全部文件处理完成但清单尚在：重复核对返回 missing/preserved，再移除清单。
- 文件在此期间重新登记：保留当前文件；不得凭旧清单删除新登记对象。

清单不提供删除授权，当前引用核验始终是必要条件。它是中断期间的技术证据，成功后不保留删除历史。
Entry 回收失败仍准确报告 catalog 已提交，并提供显式重试描述符；重启恢复独立于该运行时异常对象。

## 文件与启动边界

Linux 下 root 和 `.reclamation` 每级以 no-follow descriptor 打开。清单必须是单 hardlink 普通文件；
读取受字节上限约束，前后核对文件身份，回收前后重新核对目录绑定，删除清单前再确认名字仍指向原文件。
清单目录/文件为 symlink、hardlink、多余字段、未知文件名、非规范字节、内容损坏、越界路径或另一个 catalog
绑定时拒绝，并保留证据。启动失败会释放已经创建的 Application 资源和写入锁。

这不是任意同 UID 恶意进程持续篡改目录的隔离机制。artifact root 由 operator 管理；多个 catalog 不支持
复用同一 pending 清单。移动/复制 catalog 后仍有旧 pending 清单时，路径绑定会明确拒绝，需先核对恢复目标。
写入清单期间若留下不完整文件，恢复会报告损坏并保留，不能自动猜测该文件已经完整或 SQL 是否提交。

## 验证

`artifact-recovery.test.ts` 12 项：

- SQL 提交前、提交后、部分回收、全部回收后四个中断点，重新启动自动处理，无须调用方重传描述符。
- 清单仅有三个技术字段，成功后目录无清单；当前 metadata 保留；重复 recover 无操作。
- 回收前重新登记文件后，重启保留该文件与登记。
- 损坏、symlink、hardlink 清单使启动失败，证据和原文件保留，失败后可再次取得写入锁。
- 内容 hash 正确但包含 traversal reference 的清单仍拒绝；不同 catalog 的恢复拒绝。
- 对真实 Node Application 子进程分别在 SQL 提交前/后 SIGKILL；下一 Application 仅凭磁盘清单、SQLite
  事实与文件恢复到正确状态，验证没有依赖旧内存、异常捕获、优雅关闭或调用方保存路径列表。

全部使用合成临时 home、当前实际 SQLite/文件实现和编译后 Node 应用；不访问真实 Provider/LLM/MinerU，
不运行 Python Quick/Full/unittest。

## 剩余范围

这里覆盖进入 NoUsableContent 协调清理的对象，不是对整个 artifact root 的通用垃圾扫描。其它发布路径
尚未登记的孤立产物与历史上没有技术清单的孤立文件因为缺少可证明的删除边界而明确 Deferred；
[有界下一 PDF 重试](literature-completion.md)和[真实 Browser/MinerU source-checkout 联合旅程](browser-mineru-analysis-journey.md)
已接入。npm 包自含 Python/Cloak runtime 的安装后产品旅程仍属于发布边界，不把它写成当前能力。

## 全量验收

TS Full 成功退出：76 个测试文件、329 项测试通过；Quick、源码与测试 strict 类型检查、真实 Cloak loopback、
配置 owner、离线安装以及最终 build 均通过。日志 `/tmp/sciretriever-recovery-full.log`。
`git diff --check` 通过；没有 Python Quick/Full/unittest、依赖升级、catalog schema 改动或 Git 提交。
