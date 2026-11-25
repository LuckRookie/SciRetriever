# 上传脚本测试

这里以合成 PDF、临时连接文件与本机假 HTTP 服务验证[上传脚本](../scripts/upload_files.py)的匹配、错误、重试与恢复，不连接真实文献库。`test_zotero_import.py` 另起一个假的 Zotero 本地接口与假的文献库，验证 [Zotero 导入程序](../scripts/zotero_import.py)的列库、分段交数据、独立 PDF、找文件的顺序、200 个文件中断后续传与探测输出不含内容。`apps/server/test/skill-upload-files.test.ts` 将这些 Python 标准库测试接入仓库的 Vitest 入口；直接运行方式见 `test_upload_files.py` 的模块说明。测试与 Python 缓存不进入下载的 skill 包。
