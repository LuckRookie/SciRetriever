from pathlib import Path
import requests
from .retriver import BaseRetriver
from ..network import NetworkClient, Proxy
from ..utils.logging import get_logger
logger = get_logger(__name__)

'''
https://dev.elsevier.com/apikey/manage
Elsevier的API申请地址，一般需要学校或组织认证才能申请
'''
class ElsevierClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理elsevier网络请求的客户端
    仅接受条件，自动构建url

    额外参数：
        api_key: elsevier api key
    """
    def __init__(
        self,
        api_key:str,
        rate_limit:float|None = None,
        max_retries:int|None = None,
        retry_delay:float|None = None,
        timeout:float|None = None,
        user_agent: str|None = None,
        use_proxy: bool = False,
        proxy:Proxy|None=None,
        headers: dict[str, str]|None = None,
        allow_redirects: bool = True,
        cookie: dict[str, str]|None = None,
        verify: bool = False,
        ) -> None:
        super().__init__(
            use_proxy=use_proxy,
            proxy=proxy,
            headers=headers,
            allow_redirects=allow_redirects,
            cookie=cookie,
            verify=verify,
            rate_limit=rate_limit,
            max_retries=max_retries,
            retry_delay=retry_delay,
            timeout=timeout,
            user_agent=user_agent,
        )
        self.api_key = api_key
        self.base_url = "https://api.elsevier.com/"
        # self.default_headers.update({"mailto":self.email})
        headers={
        "X-ELS-APIKey":self.api_key,
        "Accept":'text/xml'
         }
        self.update_headers(headers)
        
    def get_doi(self,doi) -> requests.Response:
        url = self.base_url + "content/article/doi/" + doi
        response = self.get(url)
        return response

class ElsevierRetriver(BaseRetriver):
    def __init__(
        self,
        client: ElsevierClient,
        ) -> None:
        super().__init__(client)
        self.client = client
        
    def download_xml(self,doi:str,path:str|Path):
        path = Path(path)
        path.mkdir(parents=True,exist_ok=True)
        
        response = self.client.get_doi(doi)
        
        with open(path / f"{doi}.xml","w") as f:
            f.write(response.text)
            