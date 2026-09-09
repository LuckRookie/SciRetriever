# 范围与不变量

本附件是执行检查索引；权威来源见[根计划的主题映射](README.md#授权与真相源)。拟新增的工作台与持久运行合同
必须先完成 [MIGRATION-CONTRACTS](01-baseline-and-contracts.md#migration-contracts)，不能仅凭本附件进入实现。
历史研究档案不参与本附件的合同、Task、验收、状态或恢复；发现冲突时回到项目真相源和 owner Task。

## 产品结果

SciRetriever 继续是领域中立的文献收集和数据库维护工具。Browser 工作台是受控执行入口，不是通用远程
桌面；Agent 是动作和处置建议的提供者，不是文献事实写入者。普通页面访问失败、权限不足、挑战和未知
网络原因必须分别表达，不能由模型或 HTTP 状态猜成业务成功。

## 数据与事实所有权

- `MetaLiterature`、`Literature`、版本、身份、current facts、正式资产引用和 provenance 由 Literature 业务 owner
  决定，Storage 只执行已确认命令；来源 observation 必须保留，身份合并必须确定、保守且可审计。
- 文件系统保存大字节，Catalog 保存规范相对引用、hash、关系和 provenance；SQLite 不保存 BLOB 或
  机器绝对路径。
- 已接纳的原始资产和发布产物不可原地覆盖。相同目标路径只有同字节才幂等，不同字节必须留下冲突证据
  并拒绝覆盖。
- Candidate 在 Block 03 只包含 durable 字节引用、identity/version evidence 和 receipt；只有 Block 04
  `LITERATURE-ASSET-PUBLICATION` 可以写正式 Asset/LiteratureAsset/primary-pdf/current facts。
- 新增 job、attempt、event 和 Candidate ACK 是运行/交接事实，不能替代 Literature current facts，也不能成为
  第二个文献数据库。v2 schema 必须显式 inspect、backup、migrate、rollback，不能偷偷修改 v1。

## 模块边界

Browser Host 是唯一持有 Page、Context、CDP 和浏览器 vendor 对象的组件。前端、Agent、HTTP handler
和业务模块只接收类型化 Observation、Action、Frame、Transfer 和 Candidate 合同。

Action Executor 是 Browser 动作唯一入口，接受 Accepted 合同中的封闭动作和有界参数。Observation 在慢页面或
预算耗尽时返回 `partial + loading`；页面是否可操作由版本、加载状态和动作前校验判断，不依赖 `networkidle`。

Network 是 HTTP、DNS/IP、SSRF、重定向、凭据 origin 和共享预算的唯一 owner。SDK、Browser adapter
和 Provider adapter 不能绕过它自行请求或重试。

Acquisition 负责候选的基本 PDF 字节、文章身份和版本验收；实际内容判断属于 Analysis，不能设置下载阶段最小
字节/正文字符阈值；Collector 只负责 Transfer 和 durable Candidate；Literature 决定正式资产发布；Storage 只执行
已经确认的发布命令，不自行选择身份、来源、候选或业务状态。

Configuration 负责普通配置、固定 home、Provider/Model 注册和凭据 broker。secret 不进入模型输入、日志、
DTO、持久化任务或错误文本；凭据 grant 必须绑定精确 HTTPS origin 和操作范围。

## 安全与生命周期

- 默认无外部代理、无购买、无注册、无上传用户文件；任何扩大授权的能力都需要单独决策。
- 控制请求必须验证服务端认证身份、workspace、boot、page、观察版本和 control epoch；旧 epoch 的迟到
  动作不能执行。重复 request ID 必须幂等。
- 初始导航、redirect、popup、iframe、子资源、download 和 Service Worker 等 Browser 外部事件逐项经过 Network
  admission；Browser permit 释放前必须对已开始 transfer 做有界 drain，新请求不能无限延长 deadline。
- Candidate 在 `durable-ready` 后独立于截图、页面变化、Agent 停止和工作台断线继续存活。
- 关闭、取消和启动失败必须有确定性清理；无法确认外部进程退出时保留 Profile 锁并报告未知状态。
- 不访问真实凭据、用户资产或生产库。所有网络和浏览器测试使用 fake、fixture 或本地 loopback。

## 兼容性

先冻结 Python v1 的 Model、canonical JSON bytes、hash、时间/Unicode/整数规则、SQLite schema、FTS、
查询分页、关系和资产引用，再实现 TypeScript。验证必须先比较原始 bytes，再比较 hash；不能通过更新旧
golden 来消除差异。
