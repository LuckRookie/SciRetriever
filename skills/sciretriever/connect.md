# 连接

用户在文献库“设置 → 设备连接 → 连接 Agent”生成连接码，形如：

```
sr-connect1:<编码后的地址>:<配对码>
```

- 地址是 `encodeURIComponent` 过的，例如 `http%3A%2F%2Flocalhost%3A4174` 即 `http://localhost:4174`。
- 配对码以 `srp1_` 开头，10 分钟内有效、只能用一次。

## 换令牌

如果你已经照“复制给 Agent 的话”换好了令牌、写好了这两个文件，跳过这一节。

令牌只在这一次回复里出现（`result.token`）。直接写进文件，**回复的任何部分都不要打印**，包括为了排错。下面以 `~/.config/sciretriever/` 为例（Windows 用 `%APPDATA%\sciretriever\`），把 `CODE` 换成用户给的连接码：

```bash
mkdir -p ~/.config/sciretriever && chmod 700 ~/.config/sciretriever
CODE='sr-connect1:...'
python3 - "$CODE" <<'PY'
import json, os, sys, urllib.parse, urllib.request
_, encoded, pairing = sys.argv[1].strip().split(":", 2)
address = urllib.parse.unquote(encoded)
request = urllib.request.Request(
    address + "/api/v1/device-connections/exchange",
    data=json.dumps({"pairing_code": pairing}).encode(),
    headers={"Content-Type": "application/json"},
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
token = json.load(opener.open(request))["result"]["token"]
home = os.path.expanduser("~/.config/sciretriever")
os.umask(0o077)
with open(os.path.join(home, "address"), "w") as f:
    f.write(address)
with open(os.path.join(home, "curl.conf"), "w") as f:
    f.write(f'header = "Authorization: Bearer {token}"\n')
    f.write('header = "X-Sciretriever-Protocol-Version: 1"\n')
    f.write('noproxy = "*"\n')
print("已连接", address)
PY
```

之后每个请求都用这个文件带上请求头，令牌不出现在命令里：

```bash
ADDR=$(cat ~/.config/sciretriever/address)
curl -sS --config ~/.config/sciretriever/curl.conf "$ADDR/api/v1/import/instructions"
```

`noproxy` 让本机地址不走系统代理。文献库在局域网或 VPN 里、必须经代理时去掉这一行。

## 连不上

- 先告诉用户你连的是哪个地址。
- 文献库在服务器上时，提醒用户检查端口映射（例如 `ssh -L 4174:localhost:4174 <服务器>`）是否开着。
- 映射端口变了：只改 `address` 文件，令牌不变。

## 换令牌失败

| 原因码                                                                    | 怎么办                       |
| ------------------------------------------------------------------------- | ---------------------------- |
| `device-pairing-expired`、`device-pairing-used`、`device-pairing-invalid` | 请用户到设置页重新生成连接码 |
| `device-exchange-rate-limited`                                            | 等一分钟再试，不要连续重试   |

令牌被撤销（之后的请求返回 `device-revoked`）时，同样请用户重新生成连接码。
