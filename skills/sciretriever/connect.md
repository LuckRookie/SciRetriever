# 连接

在文献库“设置 → 设备连接 → 连接 Agent”生成连接码。代使用者入库需要“入库”用途；检索阅读需要“读取”，发起任务还需要“操作”。已有有效连接时直接使用，不重复配对。

请使用者把连接码交给安全输入渠道，保存到只有本人可读的文件。不要把连接码或令牌放进命令行参数、对话或日志。下文的 `PAIRING_FILE` 是这个文件，`CONFIG_DIR` 是你选定的私有连接目录，`WORK_DIR` 是本次工作的私有临时目录；用这些变量传递路径。

## 连接码换令牌

下面的命令直接保存令牌，不显示回复。它不会使用环境代理，也不跟随重定向。新建目录与连接文件只允许本人访问；已有文件也先收紧权限。连接失败时只显示状态，请按接口说明或设置页提示处理。

```bash
python3 - "$PAIRING_FILE" "$CONFIG_DIR" <<'PY'
import json, os, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Redirect refused")

try:
    prefix, encoded, pairing = Path(sys.argv[1]).read_text().strip().split(":", 2)
    address = urllib.parse.unquote(encoded).rstrip("/")
    url = urllib.parse.urlsplit(address)
    if (prefix != "sr-connect1" or url.scheme not in ("http", "https")
            or not url.hostname or url.username is not None or url.password is not None
            or url.path or url.query or url.fragment):
        raise ValueError("Invalid connection code")
    request = urllib.request.Request(
        address + "/api/v1/device-connections/exchange",
        data=json.dumps({"pairing_code": pairing}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=20) as response:
        token = json.load(response)["result"]["token"]
    if not isinstance(token, str) or not token or any(c in token for c in '\r\n"\\'):
        raise ValueError("Invalid response")
    directory = Path(sys.argv[2])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    def save(name, value):
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(value)
    save("address", address)
    save("curl.conf", 'header = "Authorization: Bearer ' + token + '"\n'
         'header = "X-Sciretriever-Protocol-Version: 1"\n'
         'noproxy = "*"\n')
except urllib.error.HTTPError as error:
    print("连接失败，HTTP " + str(error.code) + "；请检查连接码是否仍有效。", file=sys.stderr)
    sys.exit(1)
except (OSError, ValueError, KeyError, TypeError):
    print("连接失败；请检查地址、端口映射和私有文件。", file=sys.stderr)
    sys.exit(1)
print("连接已保存。")
PY
```

取得接口说明与完整 skill（包含上传脚本）：

```bash
ADDR=$(cat "$CONFIG_DIR/address")
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
curl -sS --fail --config "$CONFIG_DIR/curl.conf" \
  "$ADDR/api/v1/intake/instructions" -o "$WORK_DIR/instructions.json"
curl -sS --fail --config "$CONFIG_DIR/curl.conf" \
  "$ADDR/api/v1/intake/skill" -o "$WORK_DIR/skill.zip"
python3 -m zipfile -e "$WORK_DIR/skill.zip" "$WORK_DIR/skill"
SKILL_DIR="$WORK_DIR/skill/sciretriever"
```

如果客户端只读单篇说明，可用相同鉴权读取 `GET <地址>/api/v1/intake/agent-guide`。所有入库请求以刚取得的接口说明为准。

连不上时核对连接码中的地址和使用者的端口映射。地址发生变化时，先确认仍指向同一文献库，再更新私有连接文件。连接码过期或已使用、令牌被撤销时，请使用者重新生成连接码；不要尝试复用。令牌写入后妥善删除一次性的连接码文件。
