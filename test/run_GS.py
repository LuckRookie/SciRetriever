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
    "Cookie": "GSP=A=U5R5BQ:CPTS=1750313436:LM=1750313436:S=GiD5YrmEEKPjf0_r; NID=525=UGe5y93-2SQAWhB3_kboa3B797H8SfhHhnx9iGZnKaF4azFlRKSfDCfu5CH1AKyAc8sIXYdJ2YiwgFkHw5szb8odJJOtnJYHDlQfwR5uYC644dfx4HwDFtLqeeMp5x3l3OvVVNpzK3VSAiB_x1zlag4yyASxSGVM0p8KATPvtfuGqaIRG2UPHuBkFQ2_3RJT_8JWG8s7G_Y",
    # 用户代理
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
}

session = GSClient(
    mirror=0,
    use_proxy = True,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    rate_limit=10,
    verify=True,
    headers=headers
    )
#%%
export_path = Path("/workplace/duanjw/project/google/Experimental_synthesis_of_energetic_materials")

log_ = export_path / "logs" / 'sciretriever.log'
setup_logging(log_file = log_)

run_year(
    query="Experimental synthesis of energetic materials",
    is_fill=False,
    session=session,
    root_dir=export_path,
    )
