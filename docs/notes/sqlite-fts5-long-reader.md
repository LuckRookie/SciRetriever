# Node SQLite 长期连接与 FTS5 完整性检查

2026-09-29 在 Node v22.19.0、SQLite 3.50.4 的合成临时数据库复现。两个连接使用同一 WAL 文件：A 建 FTS5 表，B 以只读连接先完成一次检查；A 随后提交一条 FTS5 记录。A 与重新打开的只读连接检查为 `ok`，B 的后续 `PRAGMA integrity_check` 报 `malformed inverted index for FTS5 table main.f`。B 在显式 `BEGIN` 一致事务内重查仍报同样结果。此证据说明该运行时的长期连接不能单凭此报错判定磁盘索引损坏；不能据此跳过正式查询的 schema/完整性准入。

最小复现仅操作系统临时目录，结束后删除：

```js
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const root = mkdtempSync(join(tmpdir(), "sciretriever-fts-repro-"));
try {
  const path = join(root, "catalog.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE f USING fts5(title,body)");
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("PRAGMA query_only=ON");
  console.log("before", reader.prepare("PRAGMA integrity_check").get());
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("INSERT INTO f(rowid,title,body) VALUES(1,?,?)").run("synthetic", "2026");
  writer.exec("COMMIT");
  console.log("writer", writer.prepare("PRAGMA integrity_check").get());
  console.log("reader", reader.prepare("PRAGMA integrity_check").get());
  reader.exec("BEGIN");
  console.log("reader transaction", reader.prepare("PRAGMA integrity_check").get());
  reader.exec("COMMIT");
  reader.close();
  writer.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

M07 的正式 v4 worker 与只读检索适配在命令边界检测 `PRAGMA data_version`；其它连接提交后重新打开，再执行原只读/DDL/identity/完整性准入。直接测试覆盖长期 QueryApplication 运行中重复维护重建、固定版本证据读取及 DDL 损坏仍拒绝。若 Node/SQLite 升级，应重跑此复现和该旅程，不把本地现象推广为所有 SQLite 版本的行为。
