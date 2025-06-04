
from SciRetriever.searcher.crossref import CRClient,Crossref
from SciRetriever.network import Proxy

Client = CRClient(
    email = "1017379159@qq.com",
    use_proxy = False,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay=5,
    verify=True,
)

query = {
    "query": "energetic materials",
}
result = Client.get_works(
    query_params=query,
    )
print(result)
