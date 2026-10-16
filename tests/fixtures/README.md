# 共享合成测试输入

按业务能力组织可提交的离线 fixture，供模块回归与兼容测试使用。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [acquisition/](acquisition/README.md) | PDF 获取 fixture |
| [analysis/](analysis/README.md) | 模型与分析 fixture |
| [compat-v1/](compat-v1/README.md) | v1 规范编码兼容 fixture |
| [metadata/](metadata/README.md) | 元数据 fixture |
| [parsing/](parsing/README.md) | 解析服务 fixture |

## 放置边界

只保留可共享的合成输入；真实响应、文献、个人配置和运行结果进入本机 sandbox，不成为这里的 fixture。

[上级目录](../README.md) · [项目 README](../../README.md)
