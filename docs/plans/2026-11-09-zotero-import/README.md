# 计划 20：Zotero 导入与网页收藏

类型：计划
负责：ADR 0057 的落地
状态：Planned（2026-11-09 计划编写完成；技术可行性未验证；功能未交付）

## 目标

按 [ADR 0057](../../architecture/decisions/0057-zotero-import-and-browser-capture.md) 做两件事：

- 用户能从 Zotero 导入书目、分类、PDF、标签与批注。服务与 Zotero 在同一台电脑上时走本地 API，不在同一台时走网络 API，RDF 导出作兜底。
- 用户在自己的浏览器里浏览文献网页时，用扩展一键收进文献库，连同 PDF。

交付顺序按 ADR 0057：先做 Zotero 的书目、分类、PDF（01–04），再做浏览器扩展（05、06），最后做批注与 RDF 兜底（07、08）。09 收尾部署。

## 授权

Owner 2026-11-09：“写实施计划”。

- 已授权：编写本计划。
- 未授权，开工前要问 Owner：
  - 开始实施（改代码、改文档、本地提交）；
  - 01 的真实只读探测：向 `api.zotero.org` 读公开群组库，以及请 Owner 在自己的电脑上运行探测；
  - 安装或下载 Zotero 桌面端；
  - push；部署 4174 与正式库迁移（09 另问）。
- 始终不做：读取、打印或提交 Owner 的 Zotero API key 与其他凭据；Owner 的 key 由 Owner 自己在设置页填写；不修改 Owner 的 Zotero 数据。

## Human Gate

- **G1（01 开工前）**：Owner 说明 Zotero 装在哪台电脑上，以及那台电脑能否运行 Node 或 `curl`；同意 01 的探测。
- **G2（06 验收）**：Owner 在自己的 Chrome 或 Edge 里以开发者模式加载扩展，在几个有权限的出版社页面上试收藏。
- **G3（09）**：Owner 授权部署 4174 与正式库迁移；用 Owner 自己的 Zotero 做一次真实导入。

## 不变量

- 预览不写库。
- 对 Zotero 只读：只发 GET，不写回，不改 Zotero 的数据目录。
- 已有主 PDF 不被替换；资产不可覆盖；导入的 PDF 按 ADR 0029 标为“文章身份未验证”。
- 再次导入同一库不重复入库、不重复建来源记录、不删除用户在本系统里的整理。
- Zotero API key 只存 `credentials.toml`；扩展令牌只存加盐派生值；二者都不进日志、事件、报告或 Web 数据。
- 用户浏览器里的 Cookie 与登录信息不发往服务端。
- 不使用 Zotero 翻译器，不实现 Zotero Connector 协议。
- 测试只用合成数据和假的 Zotero 服务，不连真实 Zotero。

## 结果块

| 块                                | 结果                                                                    | 负责          | 依赖                        | 状态    |
| --------------------------------- | ----------------------------------------------------------------------- | ------------- | --------------------------- | ------- |
| [01](01-zotero-probe.md)          | 两种 Zotero API 的实际格式探明，假 Zotero 服务的样本定稿                | Claude        | G1                          | Pending |
| [02](02-zotero-import-backend.md) | 书目与分类导入：两种 API、预览、导入任务、编号对应、schema 16、三端入口 | Codex         | 01                          | Pending |
| [03](03-zotero-pdf.md)            | Zotero PDF：本机路径、Zotero 存储下载、网页上传 `storage` 文件夹        | Codex         | 02 的 2.1                   | Pending |
| [04](04-zotero-import-web.md)     | 入库页“从 Zotero 导入”与设置页“Zotero”分区                              | Claude        | 02 的 2.1；上传部分依赖 3.1 | Pending |
| [05](05-capture-backend.md)       | 收藏后端：配对令牌、收藏接口、`web-capture` 来源、按日批次              | Codex         | 02                          | Pending |
| [06](06-browser-extension.md)     | 浏览器扩展本体与设置页“浏览器扩展”分区                                  | Claude        | 05 的 5.1；G2               | Pending |
| [07](07-zotero-annotations.md)    | Zotero 批注导入                                                         | Codex         | 03                          | Pending |
| [08](08-zotero-rdf.md)            | RDF 导出兜底                                                            | Codex、Claude | 02、03                      | Pending |
| [09](09-closing.md)               | 收尾全量、部署与迁移、真实导入验证                                      | Claude        | 01–08；G3                   | Pending |

02 与 05 都要升级 catalog。05 开工时 02 若还没部署，两者的表并入同一次升级（schema 16），只写一个迁移脚本。

## 主要风险

| 风险                                                                           | 负责块 |
| ------------------------------------------------------------------------------ | ------ |
| 本地 API 是否提供 CSL JSON、附件路径怎样给出、批注能否列出，都还没在真机上看过 | 01     |
| 没有 DOI 等标识的条目可能误合并或重复入库                                      | 02     |
| 几千篇、几个 GB 的导入中断后要能继续，上传按文件续传                           | 02、03 |
| 收藏接口绕开 Origin 校验，令牌范围或撤销出错会扩大攻击面                       | 05     |
| 出版社页面的书目标签不统一，扩展可能读不到 DOI 或 PDF 地址                     | 06     |
| 批注坐标换算（页面框、旋转）出错会让批注错位                                   | 07     |
| 正式库从 schema 15 升级，需要停服离线迁移                                      | 09     |

## 完成标准

- 01–09 的退出条件都满足；定向测试通过，收尾跑一次全量。
- 用假 Zotero 服务覆盖：同机与不同机两种来源、预览不写库、中断后继续、再次导入幂等、已有主 PDF 不被替换、key 与令牌不外泄。
- Owner 用自己的 Zotero 在正式环境完成一次真实导入（G3），用扩展在真实出版社页面完成收藏（G2）。
- 需求、ADR 0057 指定的技术文档、页面规格与指南按实现更新，没有残留“不保存外部导入记录 ID”的现行表述（[存储技术文档](../../architecture/technical/07-versioned-storage.md)不保存清单）。

## 进度

- 2026-11-09：ADR 0057 Accepted（`adc68d0`）。本计划编写完成，未开工。

## 下一安全动作

问 Owner G1，并请 Owner 授权开始实施与 01 的探测。得到答复后由 Claude 做 01；01 完成后把 02 派给 Codex。
