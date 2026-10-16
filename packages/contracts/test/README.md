# 合同回归测试

保存 结构解析、规范编码、hash、版本兼容与包入口 的可重复离线回归。测试以 *.test.ts 命名，fixture/helper 与测试就近存放。

## 放置边界

共享合成输入放 tests/fixtures；本机真实外部测试、一次性脚本和报告放 Git 忽略的 sandbox。运行时临时 home/数据库由用例在系统临时目录创建。

相关说明：[测试目录与本机试验场](../../../tests/README.md)；[测试与验收规则](../../../HARNESS.md)。

[上级目录](../README.md) · [项目 README](../../../README.md)
