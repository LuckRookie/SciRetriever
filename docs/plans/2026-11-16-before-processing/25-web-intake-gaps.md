# 25 · 网页上的两处入库缺口

类型：计划（结果块）
负责：文献库网页上的“书目待补”，以及阅读页与文献库的“上传 PDF”改走入库的补 PDF 接口
状态：In progress（25.1、25.2 完成，2026-11-17；25.3 后端）

来源：2026-11-17 收尾核对规格标记时发现（`sandbox/reports/2026-11-17-plan25-24/markers.md`）：服务端早已实现，网页没有跟上。

## Outcome

- 文献库的“筛选”条件里有“书目待补”，行上对书目待补的文献写明“书目待补”；数据来自 `LibraryQuery.needs_metadata` 与条目的 `needs_metadata`。
- 阅读页与文献库的“上传 PDF”改用入库的补 PDF 接口 `POST /api/v1/intake/literatures/:literature_id/pdf`，没有大小上限，上传的文件归入当天的“补充文件”批次；工作台网页上不再有 16 MiB 的限制，也不再调用 `/api/v1/maintenance/ingest-pdf`；只有独立维护入口保留它。
- 产品接口说明中文件夹路由的结果写法与服务端一致（`{items}`）。

规格：[页面规格“文献库”](../../architecture/web/page-specs.md#文献库)的“书目待补”与“更多”菜单两条；[文献与材料 8.4](../../architecture/technical/03-literature-materials.md#84-书目待补)、4.4 的手动接纳；[产品接口 2.4.2](../../architecture/technical/01-product-interface.md#242-入库-http)。

## 进入条件

无。服务端都已实现。

## 责任边界

- 前端实施者：25.1、25.2。
- 后端实施者：25.3（只改 `packages/contracts/src/intake.ts` 的路由说明）。
- 不改：服务端行为、文献库的虚拟列表与行渲染的结构。

## Tasks

- [x] **25.1 书目待补**：筛选条件加“书目待补”（`needs_metadata: true`）；行上写“书目待补”（位置与样式按页面规格）。
- [x] **25.2 上传 PDF 改走补 PDF**：阅读页“更多”与文献库里的上传改用补 PDF 接口，按入库的上传方式流式发送，失败如实提示；去掉网页上的大小检查。工作台“设置 → 高级”里维护页的“接纳 PDF”同样改走补 PDF；独立维护入口（`startMaintenanceWorkbench`，没有入库路由）保留旧的维护路由与 16 MiB 检查（总设计师 2026-11-17 定）。
- [ ] **25.3 合同说明**：`intake.ts` 中文件夹路由的结果写成 `{items:[{folder_id,parent_id,name,position}]}`。

## 验证

- Web 定向测试：筛选“书目待补”发出 `needs_metadata: true`，行上有标注；上传 PDF 发往补 PDF 接口，超过 16 MiB 的合成文件也能上传，不再请求旧路由。
- 合同测试照常通过。

## 证据

- 2026-11-17，25.1、25.2 由前端实施者实现，总设计师复跑 `pnpm quick` 通过、`next-upload-pdf` 3 项通过后提交。17 MiB 以上的 PDF 从阅读页与高级工具都能上传，只走补 PDF 接口并归入当天的“补充文件”批次；独立维护入口只用旧路由（`sandbox/reports/2026-11-17-plan25-25/`）。

## 退出条件

两处网页行为与规格一致；旧的维护路由不再被网页调用。

## 恢复与交接

各项分开合入。规格与接口对不上时停下，交总设计师。
