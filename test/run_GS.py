# %%
from SciRetriever.searcher import GSClient
from SciRetriever.network import Proxy
from SciRetriever.workflow.run_GS import run_year
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
    "Cookie": "GSP=A=zS0MTg:CPTS=1752563290:SRD=66336:RTS=20284:LM=1752563290:S=gwQEYXvASEZ7JZCb; NID=525=YJqj9Km6szUdWrilczPYDK1CAvOXtwX94yUH1b9zONM4rjlEykUVOB8cVMguARmVtXIaTA5_BehSRaENk-T-zHynlbEruhtFN_J6Al4QpSKPdln5kJM5aaT6kWqaw6D63qnWHrGwUvDTmJfXoacgds_6d_-9b8Db3-t1n94qeUJpo9eJdrjZtAfJSZpW4CRmo3BaUagEO9KMzCm7VH_uT5ZezK6XM858HqXnONr6v_7CQDvnor1aE2NJkaP-4mjCxt_69cSMLEpbBphzc1PHWgeEQnpFcVlKm4eT4HP-xlkj8cCW2x45F3jljCtJ37_tN7HNadfsuylqf07cud-Txx3VwI_tQ0XvJ2GdA_YvMAbTr6enWoNxv8HrrNhJjVqeJ2cs5Ffz7u0",
    # 用户代理
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
}

session = GSClient(
    mirror=0,
    use_proxy = True,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    rate_limit=45,
    verify=True,
    headers=headers
    )
#%%
export_path = Path("/workplace/duanjw/project/google/cyclo-N5")

run_year(
    query="cyclo-N5",
    is_fill=False,
    session=session,
    root_dir=export_path,
    )
