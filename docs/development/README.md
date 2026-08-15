# 开发手册

开发工作从项目根目录 [`AGENTS.md`](../../AGENTS.md) 和 [`HARNESS.md`](../../HARNESS.md) 开始。前者说明项目边界、模块画像和验证命令，后者说明通用协作、测试、文档和 Git 规则。

## 常用入口

- [代码与文档同步映射](documentation-map.md)：代码变化需要同步核对哪些当前文档。
- [Provider 接入开发手册](provider-integration.md)：新增或实质修改 Metadata Provider 或 Acquisition Provider client/adapter 时的安全与验收检查。
- [Publisher Access Profile 准入与验证矩阵](../notes/providers/publisher-access-matrix.md)：Publisher/Access Provider 的统一证据包、三态状态、Browser rule 对齐和当前生产矩阵。
- [整体架构](../architecture/README.md)：修改领域边界、数据所有权、持久化或依赖方向前的设计真相源。

## 验证

```bash
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

Quick 只运行 Ruff lint、format check 和 compileall，适合代码开发循环和普通工作分支的
快速反馈。Full 另外运行 Pyright strict、全部 unittest、wheel 构建与内容核对；代码交付、
PR、master、发布和安装包级验收默认必须通过 Full。精确规则见根目录 `HARNESS.md`。

测试、构建和 harness 不得连接真实供应商、生产数据库或用户语料。
