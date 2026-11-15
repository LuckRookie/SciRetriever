# 上传脚本测试

这里以合成 PDF、临时连接文件与本机假 HTTP 服务验证[上传脚本](../scripts/upload_files.py)的匹配、错误、重试与恢复，不连接真实文献库。`apps/server/test/skill-upload-files.test.ts` 将这些 Python 标准库测试接入仓库的 Vitest 入口；直接运行方式见 `test_upload_files.py` 的模块说明。测试与 Python 缓存不进入下载的 skill 包。
