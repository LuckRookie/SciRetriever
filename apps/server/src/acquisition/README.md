# PDF 获取与接纳

从文献线索规划获取路线，执行 PDF 获取、候选接纳和发布。

## 下级目录

| 目录                          | 职责         |
| ----------------------------- | ------------ |
| [sources/](sources/README.md) | 通用获取来源 |

## 内容入口

- [assembly.ts](assembly.ts)：获取来源与执行组件组装。
- [tiered.ts](tiered.ts)：获取阶段、批次执行与来源级安全结果；实际请求由 Network 派发通知区分，轨迹由 Entry/Jobs 保存。
- [pdf-acceptance.ts](pdf-acceptance.ts)：PDF 文件可用性验收：先查开头的 `%PDF-` 与首尾的 `/Encrypt`，再在受限的独立进程里用随包的 MuPDF 读格式、密码、加密、是否做过修复与页数；做过修复的文件判为无效（下载不完整的文件正是这样）。错误的 reason 区分非 PDF、加密与其它无效文件，既有错误码不变。
- [candidate-publication.ts](candidate-publication.ts)：将候选发布为文献材料。

## 放置边界

供应商 URL/协议放 providers；页面动作放 browser；共享网络放 network；文献事实由 literature 接纳。下载阶段不因文章身份未验证拒绝可用 PDF。

[上级目录](../README.md)
