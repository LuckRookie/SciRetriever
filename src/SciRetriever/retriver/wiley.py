from pathlib import Path
import requests
from .retriver import BaseRetriver
from ..network import NetworkClient, Proxy
from ..utils.logging import get_logger
import urllib
logger = get_logger(__name__)

'''
https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining#accordionHeader-2
wiley最多每秒3个请求，每10分钟60个请求，请注意速率限制！
'''


class WileyClient(NetworkClient):
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
        self.base_url = "https://api.wiley.com/onlinelibrary/tdm/v1/articles/"
        headers = {
            "Wiley-TDM-Client-Token":api_key,
        }
        self.update_headers(headers)
        
    def download_doi(self,doi,file_path:Path|str):
        path = Path(file_path)
        url = self.base_url + urllib.parse.quote(doi)
        self.download_file(url=url,save_path=path)

# 目前是多余的
class WileyRetriver(BaseRetriver):
    def __init__(
        self,
        client: WileyClient,
        ) -> None:
        super().__init__(client)
        self.client = client
        
    def download_pdf(self,doi:str,file_path:str|Path|None):
        '''
        doi: 文章doi号
        file_path: pdf下载地址，默认为当前路径下的{doi}.pdf
        create_folder: 是否创建以该doi为名的文件夹，默认为True
        '''
        if file_path is None:
            file_path = Path.cwd() / f"{doi}.pdf"
        file_path = Path(file_path)
        # 如果不是pdf结尾，那么就默认为是地址
        if not file_path.name.endswith(".pdf"):
            file_path = file_path.with_suffix(".pdf")
            
        self.client.download_doi(doi=doi,file_path=file_path)