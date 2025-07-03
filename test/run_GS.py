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
    "Cookie": "NID=525=moa0yJaR-xVmtNRfrUbp5hUY7cxCR3x0i33OK2e9OSltS-_batndc06XqfOiPBPtZoJT-tzJdU_myckDGxUpo_QTbyoctfHV8_SmGlqCY2X9mcRZTz1AjYhni2vC59H6AH4P0xuk-PTe8WMchx-5rnYkcfTOa78Aryvwugd3iEdaSkfEBggwq2tayHb6vlAYDtDS4osOFqEJBRRFvOVTadXmvbdt5lrXk0gMkR-0wxobAXlNhbmyacxjXO3U1DnrBJmBcGnVzzH0XWEdFNuJeVXrau8rzS_SbQ37rPPnGFuKTBV0CmDPKVOuAVFSD0lM4UBc5SkwtX9f-xfilce5CHPiLgTIrdGJcCK6LswOVFDeRLHrlg2A3ciOVIw995cwEKbysYftMfI; GSP=A=U5R5BQ:CPTS=1750771077:SRD=262752:RTS=20263:LM=1750771077:S=-ZCswou9yJ2frb_c",
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
export_path = Path("/workplace/duanjw/project/google/Experimental_synthesis_of_energetic_materials")

run_year(
    query="Experimental synthesis of energetic materials",
    is_fill=False,
    session=session,
    root_dir=export_path,
    )
