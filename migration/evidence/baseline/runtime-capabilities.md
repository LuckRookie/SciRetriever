# RUNTIME-SPIKE 证据

## 当前状态（2026-09-12）

这是历史探针记录。当前 TS 运行时已固定为 Node `22.19.0`、`node:sqlite`、Playwright `1.55.0` 和 Linux x64；
`pnpm full` 已通过 119 个测试文件（3 个 skip）和 466 个用例（4 个 skip）。本环境未设置 operator-managed
Cloak bundle，因此 live bundle 探针保持 `not-run`，不把历史 Browser 运行结果外推为本机当前结果。

> 本表是 2026-09-09 的初次探测快照。2026-09-10 的历史选择曾由
> [支持矩阵](../final/support-matrix.md)取代：operator Cloak `146.0.7680.177.5` 已实际运行，TS Storage 使用
> Node 22.19.0 的 `node:sqlite`，目标 Browser/SQLite/PDF 组合曾进入历史 85 文件、352 项 TS Full；当前复验为
> 119 个测试文件、466 个通过用例。未验证平台和 npm 包未携带的运行依赖仍按支持矩阵处理。

日期：2026-09-09。所有检查都在本机完成，未访问真实 Provider、出版社、LLM、MinerU、用户数据或凭据。

| 能力 | 结果 |
| --- | --- |
| Node | `v22.19.0`，可用 |
| pnpm | `10.32.1`，可用 |
| Chromium | 未安装；Browser loopback smoke 暂不能运行 |
| SQLite | 系统/ Python runtime `3.49.2`；TS binding 尚未选定 |
| PDF | `pdfinfo 24.02.0`、`mutool 1.23.10` 可用；`qpdf` 未安装 |
| 文件安全原语 | 临时目录、`O_NOFOLLOW` 读取、原子 rename、目录 fsync 均通过合成字节测试 |
| 网络 | 未访问外网；DNS/SSRF/redirect 必须由 fake 和 loopback 测试覆盖 |

可重放命令：

```text
node --version
pnpm --version
pdfinfo -v
mutool -v
python -c "import sqlite3; print(sqlite3.sqlite_version)"
```

证据数据位于 [`runtime-capabilities.json`](../../spikes/runtime-capabilities.json)。Chromium 缺失是明确的后续
阻断范围，不能用旧 Python Browser 或历史研究资料代替；在获得经过审查的本地二进制前，Browser Host smoke
保持 `not-run`。
