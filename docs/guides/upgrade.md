# Catalog 升级与恢复

升级只针对停止写入后的副本执行。先创建一致 backup 并运行 restore-check，再用 `storage migrate --dry-run` 查看 v1→v2 变化，确认后执行 `storage migrate`。普通查询不会隐式升级，v1 Literature、Asset、Reference、Parser 和 Content 的 ID、hash 与相对路径保持不变。

```bash
sciretriever storage backup --path /absolute/catalog-before-v2.sqlite
sciretriever storage restore-check --path /absolute/catalog-before-v2.sqlite
sciretriever storage migrate --dry-run
sciretriever storage migrate
sciretriever storage inspect
```

升级失败时保留原副本，使用 `storage restore-check` 检查备份后再按切换手册恢复。不要复制活动 WAL 文件冒充备份，也不要覆盖唯一数据副本。当前 rollback 和演练只在合成临时 Catalog 中验证；真实用户 Catalog 需要单独授权。
