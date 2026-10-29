# 已有材料与处理结果检索

只读检索已有书目、固定校订稿与算子结果，并返回可核对的来源。缺少材料或索引时报告缺口，不自动发现、下载、建档或生成总结。

- [index.ts](index.ts)：可重建的材料索引；`build()` 强制读源，`refresh()` 只比对标量来源指纹，按篇分批暂存与 CAS 替换 active 中变化的条目；`verify()` 显式核验全部来源文字、FTS 及哈希。
- [refresh.ts](refresh.ts)：发布后的后台合并刷新；显式增量刷新与后台重建使用同一持久队列和工作者锁，运行期间的新请求合并到最新源 revision。重建来源进度由 index 的 build 回调提供，活跃索引状态由只读探针派生，队列私有序列不暴露到公开状态。请求先持久化再返回，页面断开不取消已接纳任务；失败可读、可显式重试。进程关闭中断构建，未完成意图保留给下次启动。
- [query.ts](query.ts)：书目与固定文档上下文、来源证据和分页。
- [knowledge-query.ts](knowledge-query.ts)：当前混合上下文（schema 3）。先保留材料检索排序，再读取算子结果；材料落后时仍交付可核实的命中、缺口与续页，混合游标贯穿两分支核对 active 状态。结果按固定 ID 顺序续读，使用结果 ID、内容哈希和记录 ID，不读取旧知识 artifact。
- [storage.ts](storage.ts)：离线检索存储适配。结果检索复用 [storage/processor-results.ts](../storage/processor-results.ts) 的投影、固定字节校验与证据解析，不维护第二份知识索引。
- [model.ts](model.ts)：共享的检索错误与评分标识；索引服务直接引用此模块，避免仅为错误类型加载离线 SQLite 适配器，使无库 CLI 查询的 JSON 错误输出保持干净。

分页游标绑定查询和范围，算子结果分页冻结开始时的发布范围。读取预算限制最终 JSON 大小与核验字节；来源损坏报告缺口，已有可靠分支保留。原始事实分别归 Literature、Document 和 Analysis 所有。

索引构建使用独立 generation 锁串行化同一 catalog 的构建者；锁只占用既有锁目录的派生 sidecar，不创建第二份 catalog。扫描与文件核验不持有业务写入 admission，每批最多 128 条、1 MiB，再通过共享 worker 的 catalog admission 提交；批次之间允许文件夹等业务写入。锁顺序为 generation → catalog，调用者不可在 catalog admission 内等待构建。整代重建检查 source revision；增量更新只复核正在接纳的文献，源变时只重做这一篇，已提交的其它篇保留。损坏必须显式验证/重建，不在查询或刷新前扫描全库。

整代发布后与下次增量刷新先分批回收非 active 的 ready/building 代；清空条目与 FTS 后才删代头，每批重读 active 并释放 catalog admission，取消后可续清，不自动 VACUUM。查询将 active 身份和 FTS 候选放在同一 SQLite 快照，结果组装后再核对身份；退役状态和旧游标返回需重新查询，不读取部分回收的旧代。

没有就绪代为 `index-unavailable`；源版本与 active 不同时以 `index-stale` 返回仍可验证的命中、缺口与续页，过时来源跳过后继续取有效项。游标固定代、水位及条目变更标记，增量接纳中也会失效。`refresh.ts` 的 Application owner 在启动、状态读取及周期监测时以标量检查发现落后，复用持久合并队列；只读查询不启动刷新。读取检查身份、ready、源版本与已知损坏标记，`data_version` 变化不重算全库哈希。完整健康检查仅在显式维护、备份/恢复和迁移边界执行。

[上级目录](../README.md)
