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

## 使用者给的是书目导出文件

支持的格式：`bibtex`、`biblatex`、`ris`、`csl-json`、`endnote-tagged`（EndNote 的 `.enw`，知网、万方、维普的“EndNote”导出 `.txt`）、`endnote-xml`（EndNote 的 `.xml`）、`noteexpress`（`.net`，知网的“NoteExpress”导出 `.txt`）。按扩展名选；`.txt`、`.xml` 看第一行：`%0 ` 开头是 `endnote-tagged`，`{Reference Type}:` 开头是 `noteexpress`，`<xml><records>` 是 `endnote-xml`；对不上的告诉使用者不支持，不要改写成别的格式。除 CSL JSON 外，文件不是 UTF-8 时按 GB18030 读成文字再交。文件里的附件路径只用来配对同时交来的 PDF，不要去读或上传路径所指的文件。本机的 MCP `import_bibliography` 可以不给 `format`，由文献库按文件名与内容认。

## 使用者点名要某几篇

使用者给出的是 DOI、文献的网址或标题，而不是文件时，用格式 `lookup`：建批次时 `format` 为 `lookup`、`source` 为 null；数据是一份文本，每行一篇，一个批次最多 200 行。不要自己去查书目再改写成条目，认出是哪一篇由文献库来做。

预览要反复读，直到认篇结束。结果分四种：

- 认出的、库里已有的：确认后在文献库里。
- 可能是这一篇：一个标题对上了几篇。把候选的标题、第一作者、年份交给使用者挑，**不要替他选**。
- 没认出的：默认不入库。告诉使用者是哪几行，请他给出 DOI 或更完整的标题；只有他明确要求时才决定入库。
- 没有导入的行：不支持的网址、太短或太长的标题、重复的行，按行号原样告诉使用者。

## 只有 PDF，没有书目文件

使用者给的是一个装着 PDF 的文件夹（或几个 PDF），没有 BibTeX、RIS 之类的导出文件时，用固定的程序，不要自己逐个上传：

```bash
python3 "$SKILL_DIR/scripts/import_pdfs.py" --config-dir "$CONFIG_DIR" "$FILES_DIR"
```

程序收集给定路径下的 `.pdf`（不跟随符号链接），建一个只有文件的批次（格式 `file`），逐个交上去，触发预览并等认篇结束（`--wait` 秒，默认 600），然后打印摘要并停下，不确认。摘要分几类：

- **认出**、**已在库**：确认后在文献库里。
- **没认出**：确认后照样入库，以文件名为暂时的标题，标为书目待补。
- **需要决定**：“可能是这一篇”（标题对上了几篇）与“可能重复”（像库里已有的某篇）。把这些交给使用者在网页批次页上决定，**不要替他选**。“可能是这一篇”不决定时按没认出入库；“可能重复”不决定时不入库。
- **被拒绝**：不是合法 PDF、加密等，按原因计数并逐个列出文件名；这些文件不会入库。

把摘要和程序给出的“找文献”页地址交给使用者，由他在网页上确认。只有使用者明确说过“直接入库”时才加 `--confirm`；有需要决定的条目时，程序即使带了 `--confirm` 也不确认，请使用者先在网页上决定。超过等待时间、中断或网络出错时，重跑同一条命令：它接着用同一个未确认的批次，已交过的文件不重交。

入库后还没认出的文献，可以用 [use.md](use.md#整理文献库) 的“识别书目”再认一次。

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
