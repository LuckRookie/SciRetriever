# 中性合同包

为应用与模块提供共享的数据形状、解析、规范编码和版本合同。

## 下级目录

| 目录                    | 职责         |
| ----------------------- | ------------ |
| [src/](src/README.md)   | 共享合同源码 |
| [test/](test/README.md) | 合同回归测试 |

## 内容入口

- [package.json](package.json)：@sciretriever/contracts 的公开导出。
- [tsconfig.json](tsconfig.json)：合同源码构建配置。

## 放置边界

合同保持供应商与运行环境中立；网络访问、SQL、Browser 操作和业务编排不放入本包。

SHA-256 优先使用 Web Crypto；普通 HTTP 浏览器缺少 SubtleCrypto 时使用固定 `@noble/hashes` 本地实现，保持相同字节输入与 hash 合同，不发起网络请求。标准向量、二进制边界及离线安装包有直接验证。

相关说明：[公共接口与版本兼容](../../docs/architecture/technical/01-product-interface.md)。

[上级目录](../README.md) · [项目 README](../../README.md)

- `src/processors.ts`：冻结加工输入、规范、记录/文本/旧知识引用、覆盖与集合合同；ProcessingTaskRequest v2 承载批量处理器快照。
