# PDF 获取与接纳

从文献线索规划获取路线，执行 PDF 获取、候选接纳和发布。

## 下级目录

| 目录 | 职责 |
| --- | --- |
| [sources/](sources/README.md) | 通用获取来源 |

## 内容入口

- [assembly.ts](assembly.ts)：获取来源与执行组件组装。
- [tiered.ts](tiered.ts)：获取阶段与批次执行。
- [pdf-acceptance.ts](pdf-acceptance.ts)：PDF 文件可用性验收。
- [candidate-publication.ts](candidate-publication.ts)：将候选发布为文献材料。

## 放置边界

供应商 URL/协议放 providers；页面动作放 browser；共享网络放 network；文献事实由 literature 接纳。下载阶段不因文章身份未验证拒绝可用 PDF。

[上级目录](../README.md)
