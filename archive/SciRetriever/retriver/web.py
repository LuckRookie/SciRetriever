from pathlib import Path

from .retriver import BaseRetriver
from ..network import NetworkClient, Proxy
from ..utils.logging import get_logger
logger = get_logger(__name__)

'''
https://dev.elsevier.com/apikey/manage
Elsevier的API申请地址，一般需要学校或组织认证才能申请
'''
class WebClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理web网络请求的客户端
    接受文献的URL，返回文献的HTML内容
    """
    def __init__(
        self,
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
    def download_pdf(self,url:str,file_path:Path|str):
        path = Path(file_path)
        self.download_file(url=url,save_path=path)

class WebRetriver(BaseRetriver):
    def __init__(
        self,
        client: WebClient,
        ) -> None:
        super().__init__(client)
        self.client = client
        
    def download_html(self,url:str,name:str,download_path:str|Path|None = None):
        """
        url: 文章url
        name: 文章名称
        download_path: html下载地址，默认为当前路径下的{name}.html
        """
        if download_path is None:
            download_path = Path.cwd()
        download_path = Path(download_path)
        file_path = download_path / f"{name}.html"
        # download_path.mkdir(parents=True,exist_ok=True)
        
        response = self.client.get(url)
        with open(file_path,"w") as f:
            f.write(response.text)
    def download_pdf(self,url:str,name:str,download_path:str|Path|None = None):
        """
        url: 文章url
        name: 文章名称
        download_path: pdf下载地址，默认为当前路径下的{name}.pdf
        """
        if download_path is None:
            download_path = Path.cwd()
        download_path = Path(download_path)
        file_path = download_path / f"{name}.pdf"
        # download_path.mkdir(parents=True,exist_ok=True)
        self.client.download_pdf(url=url,file_path=file_path)
