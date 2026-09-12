# Catalog 写入准入与发布窗口

2026-09-10。为 NoUsableContent 物理回收建立与所有正常发布共同使用的排他边界。

## 当前实现

`CatalogWriteAdmission` 在同一应用内按 FIFO 串行化写入；同一仍然活动的异步操作允许嵌套调用复用准入。
已经退出的异步上下文不得继续借用锁。另一个进程或独立 lock 对象尝试写入时，由 OS 非阻塞 flock 返回
明确冲突。调用者可用 `app.writes.run(async () => ...)` 包围自己的文件发布与数据库登记组合。

TS 的锁路径、内容标记和协议与现有 Python `CatalogWriteLock` 相同：catalog 父目录下
`.sciretriever-locks/catalog-<canonical-path-sha256>.lock`，标记为 `sciretriever-catalog-lock-v1` 和 path hash。
目录逐级通过 no-follow descriptor 打开；catalog/lock 文件拒绝 symlink、非普通文件和多个 hardlink；
锁定后重新核对 marker、路径绑定和 inode。已有 marker 损坏时保留证据并拒绝，不覆盖为新标记。

Linux 使用现有 util-linux 的 `/usr/bin/flock` 对继承的 descriptor 3 加锁；父 Node 进程持续持有同一 open
file description，因此短命 flock 子进程退出后锁仍有效，父进程释放 descriptor 或退出后由 OS 释放。
不增加 Python lock writer、锁业务表或手工 stale-lock 删除机制。非 Linux 当前明确拒绝，不声称跨平台支持。

Application 只构造一个 admission 并传给 FileStore/SqliteWorker。首次 schema 初始化和所有写命令通过该
admission；普通后续读取沿用 SQLite snapshot。排队的 SQL command 在进入队列前复制，避免等待期间
调用方改变它。FileStore 的 stage/read 不占用发布锁，最终 publish 使用同一准入。

以下生产组装路径持有完整“文件发布 → SQL 提交”区间：

- BrowserTransfer 完成 durable Candidate：`.candidates` 文件与 Candidate 登记。
- CandidatePublisher：receipt 准备、正式文件发布、资产事实与 receipt 提交；嵌套 collector 发布复用准入。
- ImmutableParserPublisher：全部解析文件发布与当前主 PDF CAS。
- LiteratureContentService：JSON/Markdown 发布与 metadata/content/FTS 原子接纳。

Application 关闭先停止上层执行，再关闭准入以拒绝新操作、等待已开始的写入，最后关闭底层资源。
已经持锁的发布仍可完成嵌套 SQL 提交，避免在字节发布后因为关闭产生虚假的取消结果。
独立构造的开发 FileStore/SqliteWorker 可显式注入 admission；没有注入的离线组件测试不代表受保护的产品组装。

## 直接证据

`write-admission.test.ts` 六项测试：

- flock 子进程退出后第二个 TS lock 仍冲突；实际 Python CatalogWriteLock 看到同一冲突；TS 释放后 Python 可取得。
- 同一操作嵌套成功，兄弟操作依次执行，AsyncResource 带出的过期上下文被拒绝。
- 损坏 marker、symlink catalog、symlink/hardlink lock 均拒绝且不改写它们。
- 实际 Python 进程持锁时 TS 拒绝；强制结束合成 lock fixture 后无需删除锁目录即可重新取得。
- 实际内容文件已发布、SQL 提交暂停时，独立 writer 冲突，排队维护操作不运行；提交后维护看到正式登记。
- Application 关闭等待已准入的内容发布完成，重新启动后正式 content 存在。

Candidate、Parsing、Literature、Analysis 和生命周期联合回归 35 项通过；未运行 Python Quick/Full/unittest。
Python 只作为锁协议互通的实际调用方，由 Vitest 驱动合成临时路径。

## 后续范围

此切片建立写入与回收共用的边界；后续已接入[显式描述符回收](artifact-reclamation.md)，
并由[重启恢复](artifact-recovery.md)完成自动 reconciliation、由
[NoUsableContent Entry](no-usable-content-entry.md)完成 Candidate/receipt 精确关联清理。所有操作使用同一
admission，并在锁内重新判断引用，不得仅凭此前的 retired 路径列表删除文件。任意 artifact root 的全盘
孤立文件扫描因缺少 manifest/namespace/reference 边界而明确 Deferred。
没有新增依赖包、schema 或生产切换；Linux 运行依赖补充明确列出 flock（util-linux）。

## 全量验收

TS Full 成功退出，73 个文件、288 项测试全部通过，包括真实 Cloak loopback、离线安装与最终 build。
日志 `/tmp/sciretriever-write-admission-full.log`；未运行 Python Quick/Full/unittest。
