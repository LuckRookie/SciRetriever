# 基线验证证据

日期：2026-09-09

## BASE-01

基线 commit：`e1a33d5986f654f2692d7619dd58448944ec3463`

已执行：

```text
uv run --frozen python scripts/harness.py quick
uv run --frozen python scripts/harness.py full
```

结果：两条命令均退出码 0。Quick 的 lint、format、compile 通过；Full 的 Pyright strict、全部 unittest、
wheel 构建和 wheel 内容核对通过。运行环境、版本控制文件统计和外部访问边界见
`migration/inventory.json`。

本证据不代表任何 TypeScript、Browser、真实 Provider、真实用户数据迁移或生产切换已经完成。
