# 不可变文件存储

管理 staging、受控读取、create-if-absent 发布、恢复与适用范围内的回收。

## 内容入口

- [store.ts](store.ts)：文件存储入口。
- [staging.ts](staging.ts)：未发布字节。
- [publication.ts](publication.ts)：不可变发布。
- [reader.ts](reader.ts)：受控字节读取，以及沿同一无符号链接路径检查文件指纹。
- [recovery.ts](recovery.ts)：恢复。
- [reclamation.ts](reclamation.ts)：回收。

## 放置边界

真实资产在配置指定的存储根目录，不在源码目录；同路径不同字节必须保留冲突并拒绝覆盖。

[上级目录](../README.md)
