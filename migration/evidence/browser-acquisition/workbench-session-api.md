# Browser 工作台会话与本地接口证据

> 本文件保留各次工作台切片的历史记录。当前生产对象图使用 TypeScript Application；目标 Cloak bundle 未设置时
> 相关 live 测试准确跳过，不把历史 bundle 运行结果当作本次环境的可复验结果。

2026-09-10；所有文章、PDF、Profile、catalog、资产均由本轮临时目录与 loopback fixture 生成。
未运行 Python Quick/Full/unittest，未访问真实 Provider、MinerU、模型或用户 Profile。

## 已实现路径

`startSyntheticWorkbench` 组装一个 Application、共享 Network budget、受控 Browser proxy、目标 Cloak Host、
固定文章的 Candidate intake、WorkbenchSession 和 loopback HTTP。`pnpm preview:workbench` 使用新临时 home，
开启 `127.0.0.1:4174`，正常退出关闭全部 owner 并删除该预览自己的临时目录。

Web 页面接收实际 JPEG、Observation 和当前控制权；可人工接管、释放、暂停、继续、取消、点击坐标/元素、
滚动、输入文本以及发送允许的按键。PDF Download 和普通 response 通过相同 admission/归属/字节链形成
SQLite + FileStore durable Candidate；页面面板展示真实 hash、大小、页数和内容 verdict。

## 合同与负例

- 共享闭合解析器：WorkbenchBinding、WorkbenchActionCommand、WorkbenchObservation、WorkbenchView。
  旧 action `revision` 映射 `observation_revision`；`viewport_version` 映射 `viewport_revision`。
  `document_generation` 直接来自 Host，旧 `document_version` 仍是内部观察变化计数，两者不混用。
- 原生文档替换、DOM 内容或视口变化使旧观察失效；相同截图/结构保留观察 revision 与元素引用。
  `frame_seq` 对应该完整观察；超过 2 MB 的 JPEG 整帧丢弃，不传输截断图像。
- coordinator 记录 human/agent 身份，禁止重挂载升级角色；Agent 无权使用 operator 输入接口。
  会话操作再次验证角色、页面、所有版本、epoch 和预算；每个底层输入检查当前 lease。
- 执行回执先占用 request id 再异步 dispatch；同 id 不同内容拒绝；执行失败后的重放保留失败。
  内存只保存命令 digest 与 completion，不保存人工输入原文。此回执不宣称未完成任务重启续跑。
- Agent 每次只执行一个封闭动作；人工接管使 AbortSignal 和 epoch 失效，迟到结果零执行。
- API 要求精确 loopback Host、同源 Origin、HttpOnly/SameSite cookie 和每个 tab 的 CSRF grant。
  未认证请求、跨源、缺少 CSRF、未知字段、任意 URL 动作均拒绝；grant 不进入 view/event。
- SSE 只传当前有界 view；慢客户端 writableNeedDrain 时停止添加投影，下一次发送最新值。
  图片走独立、版本绑定的端点；已经替换的 frame 请求返回 `frame-replaced`。
  连接重建读取同一会话；断线不拥有或销毁 Browser。闲置 tab grant 180 秒后释放。

## 直接测试

- `workbench-session.test.ts`：原生 generation 映射、双 viewer、旧 controller/观察、重复与冲突请求、
  takeover 撤销进行中输入、暂停预算、取消后最后画面、迟到 Agent、模型未配置。
- `workbench-http.test.ts`：真实 loopback HTTP 的 Host/Origin/cookie/CSRF、非法命令、帧替换、SSE 重连。
- `workbench.test.ts`（contracts）：别名一致性、未知权限字段、非有限/小数版本、query/二进制/vendor 泄漏拒绝。
- `browser-observation.test.ts`、`execution-policy.test.ts`：无变化 revision 稳定、同 URL 文档替换、
  并发重复 dispatch 与失败重放。
- `apps/web/test/live-workbench.test.ts`：真实目标 Cloak + 两个实际网页客户端；下载形成 durable Candidate、
  SQLite 重读、390px 抽屉/焦点/无横向溢出、控制权切换、暂停/取消后候选保留、uncertain Candidate 放弃、无 pageerror。
  显式设置 `SCIRETRIEVER_CLOAK_BUNDLE` 才运行该目标 runtime 测试；未设置时准确标记 skip。

## 首阶段边界与暂缓项

本入口仍以合成论文为 Browser fixture；正式 Literature query、发布、放弃和恢复已由工作台/Application 测试
接入，[Browser→MinerU→Analysis 联合旅程](../runtime/browser-mineru-analysis-journey.md)已覆盖实际本地 Parser 协议与
两阶段模型 loopback。没有声明真实 Provider 或站点效果。服务端具有有界背压实现；大规模慢客户端压力和
Browser 宿主跨进程重建明确 Deferred。

## 本轮切片历史结果

本切片当时的 `SCIRETRIEVER_CLOAK_BUNDLE=<operator-installed-bundle> pnpm full` 通过 53 个测试文件、182 项测试，
日志为 `/tmp/sciretriever-workbench-full.log`。最终整库 TS Full 已扩展到 85 个测试文件、352 项测试并继续实际运行
目标 Cloak，日志为 `/tmp/sciretriever-plan-full-final.log`；Quick、Test、build 和安装包 smoke 全部通过。以上均为
历史切片统计。

## 2026-09-12 当前复验

当前 `pnpm full` 在没有 `SCIRETRIEVER_CLOAK_BUNDLE` 的环境下通过 119 个测试文件（3 个 skip）和 466 个用例（4 个
skip）。Browser Host、loopback fixture、认证 tabs API、候选发布和持久任务测试均在当前 TypeScript 路径执行；
依赖 operator-managed bundle 的 live 测试保持 skip。
