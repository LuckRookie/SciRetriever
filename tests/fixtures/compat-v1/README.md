# v1 规范编码兼容 fixture

保存 固定记录及 manifest，用于验证中性合同的规范字节和 hash。

## 内容入口

- [records.json](records.json)：固定中性记录输入。
- [manifest.json](manifest.json)：记录与规范编码兼容性清单。

## 放置边界

测试预期由直接回归断言说明，原始内容只在能力切片确需调整时修改；真实测试报告放 sandbox/reports。

[上级目录](../README.md) · [项目 README](../../../README.md)
