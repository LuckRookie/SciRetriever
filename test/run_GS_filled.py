# %%
from SciRetriever.searcher import GSClient,run_year
from SciRetriever.network import Proxy
from SciRetriever.utils.logging import setup_logging
from pathlib import Path


session = GSClient(
    mirror=1,
    use_proxy = False,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    rate_limit = 10,
    verify = True,
    headers = {}
    )
#%%

export_path = Path("/workplace/duanjw/project/google/energetic_materials")

log_ = export_path / "logs" / 'sciretriever_filled.log'
setup_logging(log_file = log_)

run_year(
    query="energetic materials",
    is_fill=False,
    session=session,
    root_dir=export_path,
    )
