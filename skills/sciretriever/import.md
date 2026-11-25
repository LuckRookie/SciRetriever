# 代使用者入库

一次入库使用一个批次：建批次 → 交数据 → 预览 → 确认 → 读进度并交文件 → 读报告。使用者可以在网页“找文献”页的批次记录里查看进度。单篇网页收藏交给扩展；Zotero 见 [source-zotero.md](source-zotero.md)。

先按 [connect.md](connect.md) 取得文献库自己的接口说明。请求文件依照该说明生成；不要从记忆拼字段、格式或限额。下面使用新接口演示顺序，`WORK_DIR` 中的 JSON 文件都是按说明生成的完整请求。

## 范围与建批次

只处理使用者指定的范围；范围不清楚时先问清楚。已有明确授权就继续，使用者要求预览后把关时才在预览后等待。

只交书目时，创建批次设置 `metadata_only = true`：条目里的附件不进待交清单，而计入“不导入的内容”，不会因为没交这些文件而部分完成。需要交 PDF 时保持默认的 `false`。来源身份、数据格式与分段规则查接口说明；不要承诺再次入库必定无重复。

定义一个从文件提交请求的帮助函数，然后创建批次；保存返回的批次编号供后续使用：

```bash
ADDR=$(cat "$CONFIG_DIR/address")
post() {
  curl -sS --fail-with-body --config "$CONFIG_DIR/curl.conf" \
    -H 'Content-Type: application/json' --data-binary "@$2" \
    "$ADDR/api/v1/intake$1"
}
post /batches "$WORK_DIR/create.json" > "$WORK_DIR/created.json"
BID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["batch"]["batch_id"])' "$WORK_DIR/created.json")
```

## 交数据与预览

原始数据按接口说明分段提交，保留分段序号和原文。相同序号、相同内容可重发；内容不同会冲突，不能靠重发来替换。下面只展示第一段，多段时按同一方式继续：

```bash
post "/batches/$BID/data" "$WORK_DIR/data-0.json"
post "/batches/$BID/preview" "$WORK_DIR/empty.json"
```

预览是估计，核对书目的新增、已有、补全、冲突与未接纳，待交文件，以及“不导入的内容”。预览里的待交数量不等于本机找不到的数量。使用者要求先看时，在这里停下。

## 确认后读进度

```bash
post "/batches/$BID/confirm" "$WORK_DIR/empty.json"
post "/batches/$BID/status" "$WORK_DIR/empty.json"
```

确认立即返回，后台书目入库还在继续。按接口说明轮询状态与进度，直到完成或需要处理文件，不能因一次返回还在运行就再次确认。书目处理中，文件清单会继续增长。入库本身不触发 PDF 获取或解析任务。

## 交文件

```bash
python3 "$SKILL_DIR/scripts/upload_files.py" --config-dir "$CONFIG_DIR" "$BID" "$FILES_DIR"
```

`FILES_DIR` 是使用者指定的附件根目录，脚本也支持多个目录。脚本读取当前待交清单：需要字节就上传，已有主 PDF 时只交摘要；不会替换已有主 PDF。优先匹配导出中的相对路径。仅有文件名时，只有候选唯一且大小与清单一致才使用；大小未知、同名歧义或大小不同都会跳过，不能猜一个 PDF 上传。

单个文件失败会记录并继续，末尾列出失败或跳过的文件与原因。408、429 有限重试；服务要求等得更久时留待稍后重跑。令牌被撤销时立即停止并提示重新连接。中断后重跑同一命令，按服务端当前清单继续，已接纳的文件不再上传；没有接纳的文件从头传。

## 结束与报告

文件齐全时批次自动完成。还有交不了的文件时先汇总给使用者；只有使用者同意留下这些缺失文件时才主动结束。“直接入库”不等于允许丢下文件：

```bash
post "/batches/$BID/finish" "$WORK_DIR/empty.json"
post "/batches/$BID/report" "$WORK_DIR/empty.json"
```

报告才是实际结果：说明书目的新增、补全、已有、冲突、未接纳，以及文件的已上传、已有、冲突与未交。列出冲突和缺失文件，交给使用者决定；过期时间与状态转换查接口说明，不凭本机旧输出判断。
