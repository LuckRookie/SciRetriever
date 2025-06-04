#%% 
from SciRetriever.searcher import GSClient
from SciRetriever.network import Proxy
from SciRetriever.utils.logging import setup_logging
from pathlib import Path

export_path = Path.cwd()
log_ = export_path / 'sciretriever.log'
setup_logging(log_file = log_)

session = GSClient(
    mirror=0,
    use_proxy = True,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay = 5,
    verify=True,
    headers={}
    )
url = "https://scholar.google.com.hk/citations?view_op=search_authors&hl=zh-CN&mauthors=Matteo+Calandra"

response = session.get(url)
if response.status_code == 200:
    print("Request successful!")
else:
    print(f"Request failed with status code {response.status_code}")
