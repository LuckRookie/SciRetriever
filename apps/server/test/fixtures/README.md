# 进程测试装置

类型：开发
负责：合成工作台进程与 IPC 回归入口
状态：现行

这些入口只服务合成回归，不是产品命令。`web-lifecycle-worker.mjs` 复用私有 worker runtime 和生产 Workbench，注入受文件闸门控制的 fake parser、fake source probe 与关闭延迟，用于证明队列排空、取消和换代交接。所有 home、库和闸门由测试在系统临时目录中创建与删除，监听地址由测试限定为回环；不使用用户配置、真实来源或模型。

`web-supervisor-parent.mjs` 是父信号与 IPC 断开测试的独立宿主；`web-protocol-worker.mjs` 只发送合成的错版本/错代报文或等待启动超时，不打开库与监听端口。

[上级测试目录](../README.md)
