from pathlib import Path
from bs4 import BeautifulSoup
import requests
from .retriver import BaseRetriver
from ..network import NetworkClient, Proxy
from ..utils.logging import get_logger
import urllib
logger = get_logger(__name__)

"""
scihub客户端
"""


class ScihubClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理scihub网络请求的客户端
    仅接受条件，自动构建url

    额外参数：
        api_key: scihub api key
    """

    def __init__(
        self,
        rate_limit: float | None = None,
        max_retries: int | None = None,
        retry_delay: float | None = None,
        timeout: float | None = None,
        user_agent: str | None = None,
        use_proxy: bool = False,
        proxy: Proxy | None = None,
        headers: dict[str, str] | None = None,
        allow_redirects: bool = True,
        cookie: dict[str, str] | None = None,
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
        self.available_urls = self._get_available_scihub_urls()
        self.base_url = self.available_urls[0] + "/"

    def _get_available_scihub_urls(self):
        """
        Finds available scihub urls via http://tool.yovisun.com/scihub/
        """
        urls = []
        res = self.session.get(url="http://tool.yovisun.com/scihub/")
        s = self.get_soup(res.content)
        for a in s.find_all("a", href=True):
            if "sci-hub." in a["href"]:
                urls.append(a["href"])
        return urls

    # def get_doi(self, doi) -> requests.Response:
    #     url = self.base_url + doi
    #     response = self.get(url)
    #     return response
    def download_doi(self,doi:str,file_path:Path|str) -> None:
        path = Path(file_path)
        
        for available_base_url in self.available_urls:
            res = self.get(url=available_base_url + '/' + urllib.parse.quote(doi))
            if res.status_code == 200:
                self.base_url = available_base_url + '/'
                break
        else:
            raise Exception('http://tool.yovisun.com/scihub/中各个链接均无法在程序中正常运行，下载失败！')

        logger.info(f"获取 {self.base_url + urllib.parse.quote(doi)} 中...")
        s = self.get_soup(res.content)
        frame = s.find('iframe') or s.find('embed')
        if frame:
            url = frame.get('src') if not frame.get('src').startswith('//') else 'http:' + frame.get('src')
            self.download_file(url=url,save_path=path)
        else:
            logger.info(f"scihub中没有文章{doi}，跳过下载")

class ScihubRetriver(BaseRetriver):
    def __init__(
        self,
        client: ScihubClient,
    ) -> None:
        super().__init__(client)
        self.client = client

    def download_pdf(
        self, doi: str, name: str | None = None, download_path: str | Path | None = None
    ):
        """
        doi: 文章doi号
        file_path: pdf下载地址，默认为当前路径下的{doi}.pdf
        """
        if "/" in doi:
            doi_path = doi.replace("/", "_")
        else:
            doi_path = doi
        if download_path is None:
            download_path = Path.cwd()
        download_path = Path(download_path)
        if name is None:
            name = doi_path
        file_path = download_path / f"{name}.pdf"
        self.client.download_doi(doi=doi,file_path=file_path)
        # file_path.mkdir(parents=True,exist_ok=True)

        
