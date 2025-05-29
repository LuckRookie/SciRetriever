# %%
from SciRetriever.searcher import GSClient,GSWorkplace
from SciRetriever.network import Proxy
from SciRetriever.utils.logging import get_logger,setup_logging
from pathlib import Path

export_path = Path("/workplace/duanjw/project/google/energetic_material")

log_ = export_path / "logs" / 'sciretriever.log'
setup_logging(log_file = log_)

# headers = {
#     # 核心请求头
#     "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
#     "Accept-Encoding": "gzip, deflate, br, zstd",

#     # 安全相关头
#     "Sec-Fetch-Dest": "document",
#     "Sec-Fetch-Mode": "navigate",
#     "Sec-Fetch-Site": "same-origin",
#     "Sec-Fetch-User": "?1",
#     "Upgrade-Insecure-Requests": "1",

#     # Cookie处理（必须替换）
#     "Cookie": "NID=524=ShKZU6Bdi5UILSEvR5sHo6Ujt3LJ4p5isr_kkAchTuDwKDYz8jZppLFwrF4lsOi1wQUgLimSDGRZG5cchdBTHQMee3xOTBhVHu-AFhlp5uTUR9G5SnmuSyrFF4RYGnOpOq1eqByrGROasqH9xJmc1lljrUotZw2ERovWnAQ-qySvk9_zbUap_Oe4bhT8Drv6Om_6SXpcq66XLZt08NQ; GSP=LD=en:CF=4:CO=0:LM=1748413938:S=cQLkOQNiSWeszEr3",
    
#     # 用户代理
#     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",

# }

session = GSClient(
    mirror=1,
    use_proxy = False,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    verify=True,
    headers={}
    )
#%%

totle_GS = GSWorkplace.from_root_dir(root_dir=export_path,session=session)

totle_GS.run(is_fill=True)
