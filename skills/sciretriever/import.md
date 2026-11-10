# 导入

所有导入都经过一个**导入会话**：建会话 → 交数据 → 预览 → 确认 → 交文件 → 结束。用户在网页“入库 → 导入 → 导入会话”里实时看得到你的会话，也可以在那里确认或取消。

字段、格式名、上限与错误码以 `GET <地址>/api/v1/import/instructions` 为准；下面只讲顺序和判断。请求都是 `POST`，正文是 `{"protocol_version":1,"request":{...}}`，回复在 `result` 里。

```bash
ADDR=$(cat ~/.config/sciretriever/address)
call() {  # call <路径> <request 的 JSON>
  curl -sS --fail-with-body --config ~/.config/sciretriever/curl.conf \
    -H 'Content-Type: application/json' \
    --data-binary "{\"protocol_version\":1,\"request\":$2}" "$ADDR$1"
}
```

## 0. 先问清楚

- 导什么：整个库、某个分类（分组），还是指定的几条；要不要 PDF。
- 用户要不要在确认前先看预览。要看就在第 3 步后停下。

## 1. 建会话

- 来源有自己的库编号（例如 Zotero 的用户库或群组库）时，填 `library`；同一个来源库以后再导一次就是同步，不会重复入库。
- 只是一个导出文件、没有库编号时，`library` 填 `null`。会话的来源名就用 `file_name`。
- `scope` 用一句话写清这次的范围，例如“分类：固态电解质”。

```bash
call /api/v1/import/sessions '{"format":"bibtex","library":null,"scope":"分类：固态电解质","file_name":"solid.bib"}'
```

记下 `session.session_id`，后面记作 `$SID`。返回 `import-library-busy` 说明同一个来源库已有进行中的会话：先读它的状态，接着用它，或请用户决定是否取消。

## 2. 交数据

把导出的原始内容发过去。书目格式（BibTeX、RIS、CSL JSON）的 `data` 是整份文本；数据大时分几段，每段带序号 `sequence`，从 0 开始。重发同一序号就是替换那一段。

数据可能很大，先把整个请求写进文件再发，不要放在命令行参数里：

```bash
python3 -c 'import json,sys; json.dump({"protocol_version":1,"request":{"sequence":int(sys.argv[2]),"data":open(sys.argv[1],encoding="utf-8").read()}}, open("/tmp/sciretriever-data.json","w"))' solid.bib 0
curl -sS --fail-with-body --config ~/.config/sciretriever/curl.conf \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/sciretriever-data.json "$ADDR/api/v1/import/sessions/$SID/data"
```

## 3. 预览

```bash
call /api/v1/import/sessions/$SID/preview '{}'
```

预览不写库，是估计。告诉用户：

- 书目：`records` 里的新增（`created`）、已在库（`matched` 与 `enriched`）、冲突、未接纳；
- 文件：要上传的（`files.upload`）和只需核对的（`files.hash`）。这时文件都还没交，所以 `files.missing` 等于两者之和，不是“找不到”；
- 不导入的内容（`excluded`）。

用户要把关时在这里停下。

## 4. 确认

```bash
call /api/v1/import/sessions/$SID/confirm '{}'
```

确认后书目先入库；以后读到的报告才是实际结果。用户说过“你直接导”“直接确认”时可以自己确认；否则等用户在网页或对话里确认。

## 5. 交文件

服务端列出要交的文件。`action` 为 `upload` 的要上传文件内容（这篇还没有 PDF）；为 `hash` 的只报文件的 SHA-256（库里已有 PDF，相同记已有，不同记冲突，不替换）。

文件多时用 skill 随附的脚本 `scripts/upload_files.py`（在 skill 包里；只读了说明、没有 skill 时，先下载 `GET <地址>/api/v1/device-connections/skill` 并解压，脚本在 `sciretriever/scripts/` 下）。脚本它反复读取缺失清单，按文件名（或导出里的相对路径）在你给的文件夹里找文件，逐个上传或报哈希，中断后再运行会从服务端的清单接着做，已交的不会重复。

```bash
python3 <skill 目录>/scripts/upload_files.py "$SID" <导出文件夹，即 .bib 所在的那个>
```

找不到的文件脚本会列出来。问用户文件在哪里：用户把文件放进文件夹后，再运行一次脚本即可。

## 6. 结束与报告

文件全部交齐后会话自动完成。有交不了的文件时，先告诉用户缺哪些；**结束会把它们记为未交，即使用户说过“直接导”，也要等用户同意再结束**：

```bash
call /api/v1/import/sessions/$SID/finish '{}'
call /api/v1/import/sessions/$SID/report '{}'
```

把报告里的实际结果告诉用户：书目的新增、补全、已在库、冲突、未接纳；文件的已上传（`uploaded`）、已有（`existing`）、冲突（`conflicts`），以及还没交的（`missing`；会话结束后它们在文件清单里仍是 `pending`，这就是“未交”），逐个说出冲突和未交的文件名。冲突交给用户处理。不结束的会话 7 天没有新文件交上来会自动结束。
