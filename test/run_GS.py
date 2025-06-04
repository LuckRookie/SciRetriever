# %%
from SciRetriever.searcher import GSClient,run_year
from SciRetriever.network import Proxy
from SciRetriever.utils.logging import setup_logging
from pathlib import Path

headers = {
    # 核心请求头
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",

    # 安全相关头
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",

    # Cookie处理（必须替换）
    "Cookie": "GSP=A=W74LKA:CPTS=1749016130:LM=1749016130:S=o4wvaggitIHAcGCP; NID=524=Y06GEvX8-bQiauciZyxnA63SlsEklv6ky2ivA3zEYjbXL6pGLW154QAN_Ag5AMjVZhlXmT9RfYcGROiqwrHU8vOoWh8NXJaC5GRp9nZYdax54siFrZbCe9Dyr8R9SxWZ_bc5OWOfcz5ueRzgr41cfVZLMX4Ic2A95LtScdQ0_hl4Ogg66WqfQTKMA-o99pKXjXAUdQk4Xhk",
    # 用户代理
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
}

session = GSClient(
    mirror=0,
    use_proxy = True,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    rate_limit=60,
    verify=True,
    headers=headers
    )
#%%
export_path = Path("/workplace/duanjw/project/google/energetic_materials")

log_ = export_path / "logs" / 'sciretriever.log'
setup_logging(log_file = log_)

run_year(
    query="energetic materials",
    is_fill=False,
    session=session,
    root_dir=export_path,
    )
