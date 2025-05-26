"""
Google Scholar searcher implementation.
"""

from multiprocessing import Value
from sys import path
from typing_extensions import override
import requests
import time
from typing import Any
import json
from bs4 import BeautifulSoup, Tag
import bibtexparser
from pathlib import Path
import re
# from scholarly import scholarly,ProxyGenerator
# from bibtexparser.bibdatabase import BibDatabase

from ..models.paper import Paper
from ..network import NetworkClient, Proxy, RateLimiter
from ..utils.exceptions import SearchError, RateLimitError,SciRetrieverError
from ..utils.logging import get_logger,setup_logging
from .searcher import BaseSearcher


class GSRowError(SciRetrieverError):
    """Raised when there is an error parsing a row."""
    pass
class GSCaptchaError(SciRetrieverError):
    """Raised when google scholar have Captcha"""
    pass
_GoogleScholar = [
    "https://scholar.google.com",
    "https://scholar.aigrogu.com"
]
setup_logging(log_file=Path.cwd()/'logs/sciretriever.log')
logger = get_logger(__name__)

_SCHOLARPUBRE = r'cites=([\d,]*)'
_CITATIONPUB = '/citations?hl=en&view_op=view_citation&citation_for_view={0}'
_SCHOLARPUB = '/scholar?hl=en&oi=bibs&cites={0}'
_CITATIONPUBRE = r'citation_for_view=([\w-]*:[\w-]*)'
_PUBSEARCH = '/scholar?hl=en&q={0}'
# 关键的是cid，这个位置({1})根本就不关键
_BIBCITE = '/scholar?hl=en&q=info:{0}:scholar.google.com/&output=cite&scirp={1}&hl=en'
_CITEDBYLINK = '/scholar?hl=en&cites={0}'
_MANDATES_URL = '/citations?view_op=view_mandate&hl=en&citation_for_view={0}'

_BIB_MAPPING = {
    'ENTRYTYPE': 'pub_type',
    'ID': 'bib_id',
    'year': 'pub_year',
}

_BIB_DATATYPES = {
    'number': 'str',
    'volume': 'str',
}
_BIB_REVERSE_MAPPING = {
    'pub_type': 'ENTRYTYPE',
    'bib_id': 'ID',
}
class GSClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理GoogleScholar网络请求的客户端
    仅接受网址后面的,而不需要全部网址

    参数：
        use_proxy: 是否使用代理
        proxy: 代理对象
        mirror: 镜像网站,0为官方网站
    """
    def __init__(
        self,
        mirror:int = 0,
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
        self.mirror:int = mirror
        self.base_url:str = _GoogleScholar[self.mirror]

    def _get_mirror_response(self,url:str,response:requests.Response) -> requests.Response:
        """
        从镜像网站获取响应
        """
        
        # 检查是否是验证页面
        if 'AutoJump' in response.text:
            # print("检测到验证页面，正在提取验证Cookie...")
            
            # 从页面中提取cookie值
            cookie_match = re.search(r'document\.cookie="google_verify_data=([^;]+);', response.text)
            if cookie_match:
                verify_data = cookie_match.group(1)
                
                # 手动设置cookie
                self.session.cookies.set('google_verify_data', verify_data, domain='scholar.aigrogu.com', path='/')
                # 等待一小段时间模拟浏览器行为
                time.sleep(1)
                
                # 再次请求
                response = self.get(url=url)
        # 处理响应
        if response.status_code == 200:
            return response
        else:
            logger.error(f"Failed to get page: {response.status_code}")
            return response


    def get_page_soup(self,scholar_url:str) -> tuple[BeautifulSoup, str]:
        url:str = self.base_url + scholar_url
        response = self.get(url=url)
        
        if response.status_code != 200:
            raise Exception(f"Failed to get page: {response.status_code}")
        
        if self.mirror == 1:
            response = self._get_mirror_response(url = url,response = response)
            soup = BeautifulSoup(response.text, "html.parser")
            return soup,response.text

        else:
            has_captcha = self._requests_has_captcha(response.text)
            if not has_captcha:
                soup = BeautifulSoup(response.text, "html.parser")
                return soup,response.text
            else:
                logger.warning("Google Scholar has detected a captcha,auto switch website to mirror=1")
                self.mirror = 1
                self.base_url = _GoogleScholar[self.mirror]
                return self.get_page_soup(scholar_url=scholar_url)
            
    def search_pubs(self,url:str):
        """
        搜索论文
        """
        return GoogleScholar.from_url(url = url,session = self)
    
    def _has_captcha(self, got_id, got_class) -> bool:
        _CAPTCHA_IDS = [
            "gs_captcha_ccl", # the normal captcha div
            "recaptcha", # the form used on full-page captchas
            "captcha-form", # another form used on full-page captchas
        ]
        _DOS_CLASSES = [
            "rc-doscaptcha-body",
        ]
        if any([got_class(c) for c in _DOS_CLASSES]):
            raise GSCaptchaError("Google Scholar has detected a captcha.")
        return any([got_id(i) for i in _CAPTCHA_IDS])
    
    def _requests_has_captcha(self, text:str) -> bool:
        """Tests whether some html text contains a captcha.

        :param text: the webpage text
        :type text: str
        :returns: whether or not the site contains a captcha
        :rtype: {bool}
        """
        return self._has_captcha(
            got_id = lambda i : f'id="{i}"' in text,
            got_class = lambda c : f'class="{c}"' in text,
        )
class GoogleScholarSearcher(BaseSearcher):
    """Implementation of BaseSearcher for Google Scholar."""
    
    def __init__(
        self,
        client: GSClient|None = None,
        ):
        """
        Initialize the Google Scholar searcher.
        
        Args:
            api_key: Not used for scholarly library, but kept for consistency
        """
        if client is None:
            client = GSClient()
        super().__init__(client = client)
        self.client:GSClient = client
        # self._configure_scholarly()
        logger.info("Initialized Google Scholar searcher")
    
    
    def search(self, query: str, limit: int = 10, **kwargs) -> list[Paper]:
        return super().search(query, limit, **kwargs)
    # def _configure_scholarly(self):
    #     """Configure scholarly library settings."""
    #     # This method can be extended to configure proxies or other settings
    #     # scholarly.use_proxy(...)
    #     self.scholarly = scholarly
        
    #     if self.client.proxy:
    #         logger.info(f"Setting proxy for scholarly: {self.client.proxy}")
    #         proxy = self.client.proxy.get_proxies()
    #         pg1 = ProxyGenerator()
    #         pg2 = ProxyGenerator()
            
    #         success1 = pg1.SingleProxy(http=proxy['http'])
    #         success2 = pg2.SingleProxy(http=proxy['http'])
    #         if success1 and success2:
    #             logger.info("Successfully set proxies for scholarly")
    #             self.scholarly.use_proxy(pg1,pg2)
    #         else:
    #             logger.warning("Failed to set proxies for scholarly")

    # def search(
    #     self, 
    #     query: str, 
    #     limit: int = 10, 
    #     fields: Optional[List[str]] = None, 
    #     **kwargs
    # ) -> List[Paper]:
    #     """
    #     Google Scholar搜索的通用方法
        
    #     Args:
    #         query: 搜索的关键词
    #         limit: 默认限制返回的文献数量,设置为0则不限制
    #         fields: 默认不用
    #         **kwargs: 附加参数:
    #             year_start: 起始日期
    #             year_end: 结束日期
                
    #     Returns:
    #         返回一个Paper对象列表(暂定)
            
    #     Raises:
    #         SearchError: If the search fails
    #     """
    #     logger.info(f"Searching Google Scholar for: {query}")
        
    #     year_start = kwargs.get('year_start')
    #     year_end = kwargs.get('year_end')
        
    #     # Build the query with year filters if provided
    #     full_query = query
    #     if year_start and year_end:
    #         logger.info(f"Filtering by year range: {year_start} to {year_end}")
    #         full_query = f"{query} year_lo:{year_start} year_hi:{year_end}"
    #     elif year_start:
    #         logger.info(f"Filtering by start year: {year_start}")
    #         full_query = f"{query} year_lo:{year_start}"
    #     elif year_end:
    #         logger.info(f"Filtering by end year: {year_end}")
    #         full_query = f"{query} year_hi:{year_end}"
        
    #     papers = []
    #     try:
    #         search_query = self.scholarly.search_pubs(full_query)
            
    #         # Collect the specified number of results
    #         for _ in range(limit):
    #             try:
    #                 pub = next(search_query)
    #                 papers.append(self._convert_to_paper(pub))
    #                 # Add a small delay to avoid being blocked
    #                 time.sleep(1)
    #             except StopIteration:
    #                 logger.info("No more results from Google Scholar")
    #                 break
    #             except Exception as e:
    #                 logger.error(f"Error processing publication: {e}")
    #                 continue
            
    #         logger.info(f"Found {len(papers)} papers on Google Scholar")
    #         return papers
            
    #     except Exception as e:
    #         logger.error(f"Error searching Google Scholar: {e}")
    #         raise SearchError(f"Failed to search Google Scholar: {e}")
    
    # def get_citations(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
    #     """
    #     获取引用改文献的其他论文
        
    #     Args:
    #         paper: A Paper object or DOI string
    #         limit: Maximum number of results to return

    #     Returns:
    #         A list of Paper objects
    #     """
    #     if isinstance(paper, str):
    #         # If only DOI is provided, try to get the paper first
    #         paper_obj = self.get_paper_by_doi(paper)
    #         if not paper_obj or 'cluster_id' not in paper_obj.metadata:
    #             logger.error(f"Could not find paper with DOI: {paper}")
    #             raise SearchError(f"Could not find paper with DOI: {paper}")
    #         cluster_id = paper_obj.metadata.get('cluster_id')
    #     else:
    #         if 'cluster_id' not in paper.metadata:
    #             logger.error("Paper object does not contain Google Scholar cluster_id")
    #             raise SearchError("Paper object does not contain Google Scholar cluster_id")
    #         cluster_id = paper.metadata.get('cluster_id')
        
    #     logger.info(f"Retrieving citations for cluster_id: {cluster_id}")
    #     try:
    #         citations = []
    #         citation_query = scholarly.get_citedby(cluster_id)
            
    #         for _ in range(limit):
    #             try:
    #                 citation = next(citation_query)
    #                 citations.append(self._convert_to_paper(citation))
    #                 # Add a small delay to avoid being blocked
    #                 time.sleep(1)
    #             except StopIteration:
    #                 logger.info("No more citation results")
    #                 break
    #             except Exception as e:
    #                 logger.error(f"Error processing citation: {e}")
    #                 continue
            
    #         logger.info(f"Found {len(citations)} citations")
    #         return citations
            
    #     except Exception as e:
    #         logger.error(f"Error retrieving citations: {e}")
    #         raise SearchError(f"Failed to retrieve citations for {cluster_id}: {e}")
    
    # def get_references(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
    #     """
    #     获取该文献引用的论文的信息

    #     Args:
    #         paper: A Paper object or DOI string
    #         limit: Maximum number of results to return
            
    #     Returns:
    #         A list of Paper objects
    #     """
    #     logger.warning("Google Scholar doesn't support retrieving references directly")
    #     return []
    
    # def _convert_to_paper(self, data: Dict[str, Any]) -> Paper:
    #     """将获取到的页面转化为Paper类型"""
    #     # Extract authors
    #     authors = []
    #     if "bib" in data and "author" in data["bib"]:
    #         authors = data["bib"]["author"]
        
    #     # Extract year
    #     year = None
    #     if "bib" in data and "pub_year" in data["bib"]:
    #         try:
    #             year = int(data["bib"]["pub_year"])
    #         except (ValueError, TypeError):
    #             pass
        
    #     # Extract journal/venue
    #     journal = None
    #     if "bib" in data and "venue" in data["bib"]:
    #         journal = data["bib"]["venue"]
        
    #     # Extract title
    #     title = "Untitled"
    #     if "bib" in data and "title" in data["bib"]:
    #         title = data["bib"]["title"]
        
    #     # Extract abstract (Google Scholar often doesn't provide this)
    #     abstract = None
    #     if "bib" in data and "abstract" in data["bib"]:
    #         abstract = data["bib"]["abstract"]
        
        
    #     # # Extract DOI from URL if available
    #     # doi = None
    #     # if "pub_url" in data:
    #     #     url = data["pub_url"]
    #     #     # Try to extract DOI from URL
    #     #     if "doi.org/" in url:
    #     #         doi = url.split("doi.org/")[-1]
        
    #     # # Also check for DOI in the bib data
    #     # if not doi and "bib" in data and "doi" in data["bib"]:
    #     #     doi = data["bib"]["doi"]
        
    #     return Paper(
    #         title=title,
    #         authors=authors,
    #         abstract=abstract,
    #         doi=doi,
    #         url=data.get("pub_url"),
    #         publisher=None,  # Google Scholar doesn't provide publisher info
    #         year=year,
    #         journal=journal,
    #         tags=[],  # Google Scholar doesn't provide tags/fields
    #         downloaded=False,
    #         metadata=data,
    #     )
    @staticmethod
    def _build_url(baseurl: str, patents: bool = True,
                    citations: bool = True, year_low: int|None=None,
                    year_high: int|None=None, sort_by: str = "relevance",
                    include_last_year: str = "abstracts",
                    start_index: int = 0
                    )-> str:
        """
        构建Google Scholars查询所需要的参数.
        baseurl: 基础url
        patents: 是否包括专利
        citations: 是否包括引用
        year_low: 起始年份
        year_high: 结束年份
        sort_by: 排序方式，relevance,date
        include_last_year: 是否包括最近一年的文章，只有在sort_by为date时有效
        start_index: 结果的起始页面,必须为10的倍数
        
        """
        url = baseurl

        yr_lo = '&as_ylo={0}'.format(year_low) if year_low is not None else ''
        yr_hi = '&as_yhi={0}'.format(year_high) if year_high is not None else ''
        citations_p = '&as_vis={0}'.format(1 - int(citations))
        patents_p = '&as_sdt={0},33'.format(1 - int(patents))
        sortby = ''
        
        if start_index % 10 != 0:
            raise ValueError("start_index must be a multiple of 10")
        
        start = '&start={0}'.format(start_index) if start_index > 0 else ''

        if sort_by == "date":
            if include_last_year == "abstracts":
                sortby = '&scisbd=1'
            elif include_last_year == "everything":
                sortby = '&scisbd=2'
            else:
                raise ValueError("Invalid option for 'include_last_year', available options: 'everything', 'abstracts'")
        elif sort_by != "relevance":
            raise ValueError("Invalid option for 'sort_by', available options: 'relevance', 'date'")

        # improve str below
        return url + yr_lo + yr_hi + citations_p + patents_p + sortby + start

    def search_publication(self,query:str|None = None,patents: bool = True,
                            citations: bool = True, year_low: int|None = None,
                            year_high: int|None = None, sort_by: str = "relevance",
                            include_last_year: str = "abstracts",
                            start_index: int = 0
                            )-> "GoogleScholar":
        url = self._build_url(
            baseurl = _PUBSEARCH.format(requests.utils.quote(query)),
            patents = patents,
            citations = citations,
            year_low = year_low,
            year_high = year_high,
            sort_by = sort_by,
            include_last_year = include_last_year,
            start_index = start_index,
        )

        return self.client.search_pubs(url)
        
class Total_GoogleScholar():
    """
    Google Scholar的总对象,针对每一次查询。还需要用于与外界交互。
    """
    def __init__(
        self,
        start_page: "GoogleScholar",
        root_dir:Path|None = None,
        
        ) -> None:
        self._pages:list[GoogleScholar] = []
        self.root_dir:Path = root_dir if root_dir else Path.cwd()
        json_list = list(self.root_dir.glob("page_*.json"))
        self.num_list:list[int] = [int(json.stem.split("_")[-1]) for json in json_list]
        
        if start_page.page_num in self.num_list:
            self.start_page:GoogleScholar = GoogleScholar.from_json(self.root_dir / f"page_{self.start_page.page_num}.json")
        else:
            self.start_page = start_page

        self.totle_num:int = self.start_page.totle_results
    @classmethod
    def from_root_dir(cls,root_dir:Path):
        json_list:list[Path] = list(root_dir.glob("page_*.json"))
        num_list:list[int] = [int(path.stem.split("_")[-1]) for path in json_list]
        num_list.sort()
        page_list:list[GoogleScholar] = []
        for num in num_list:
            json_file = root_dir / f"page_{num}.json"
            page = GoogleScholar.from_json(json_file)
            page_list.append(page)
        return cls(
            start_page = page_list[0],
            root_dir = root_dir,
            
        )
    def append(self,page:"GoogleScholar"):
        self._pages.append(page)
        
    def __iter__(self):
        return self
    
    def __len__(self):
        return len(self._pages)
    
    def __getitem__(self,index:int):
        return self._pages[index]
    
    def __next__(self):
        if self._pages == []:
            if self.start_page:
                self.append(self.start_page)
                return self.start_page
            else:
                raise ValueError("ERROR: 请提供start_page")
            
        end_pages = self._pages[-1]
        if end_pages.next_url:
            next_page = next(end_pages)
            self.append(next_page)
            return next_page
        else:
            raise StopIteration
    
    def fill_all_bib(self):
        for page in self._pages:
            page.fill_all_bib()
    
    def dump_dict(self) -> dict[str,str|int|list[Any]]:
        TGS_dict = {
            "totle_num":self.totle_num,
            "root_dir":str(self.root_dir),
            "pages":[page.dump_dict() for page in self._pages],
        }
        return TGS_dict
    
    def dump_json(self):
        return json.dumps(self.dump_dict(),indent=4)
    
    def export_json(self):
        for num,page in enumerate(self._pages):
            page.export_json(self.root_dir / f"page{num}.json")

            
    # @classmethod
    # def load_json(cls,json_path:Union[str,Path],session:GSClient):
    #     # 从json中加载
    #     if isinstance(json_path,str):
    #         json_path = Path(json_path)
    #     with open(json_path, "r", encoding="uft-8") as f:
    #         TGS_dict = json.load(f)
        
    #     TGS = Total_GoogleScholar(start_page=None)
        
class GoogleScholar():
    """
    Google Scholar的页面对象
    """
    def __init__(
        self,
        url:str|None = None,
        session: GSClient|None = None,
        html:str|None = None,
        soup:BeautifulSoup|None = None,
        rows:list["GSRow"]|None = None,
        param_list:list[str]|None = None,
        page_num:int|None = None,
        next_url:str|None = None,
        totle_results:int|None = None,
        ) -> None:
        if not session:
            logger.warning("未提供session,将使用默认session")
            session = GSClient()
        self.session:GSClient = session
        self.url:str|None = url
        self.soup:BeautifulSoup|None = soup
        self.html:str|None = html
        self.rows:list["GSRow"]|None = rows
        self.page_num:int|None = page_num
        self.param_list:list[str]|None = param_list
        self.next_url:str|None = next_url
        self.totle_results:int = totle_results if totle_results else 0
        
        # if html:
        #     # 优先从html中获得soup
        #     self.soup = BeautifulSoup(html, "html.parser")
        #     self.html = html
        # else:
        #     self.soup,self.html = self.session.get_page_soup(url)

        # # 文章的rows
        # self.rows = self.soup.find_all('div', class_='gs_r gs_or gs_scl') + self.soup.find_all('div', class_='gsc_mpat_ttl')
        # if self.rows == []:
        #     raise GSRowError("未找到任何文章")
        # # 删除一些没有data-cid的文章或者广告
        # self.rows = [GSRow(row,self.session) for row in self.rows if row.get("data-cid")]
        
        # param = self.url.split("?")[-1] if url else ""
        # self.param_list = param.split("&")
        
        # self.page_num = self._get_page_num()
        # # 下一页的按钮
        # self.next_url = self.soup.find(class_='gs_ico gs_ico_nav_next').parent['href'] if self.soup.find(class_='gs_ico gs_ico_nav_next') else None
        # self.totle_results = self._get_total_results()
    
    @classmethod
    def from_url(
        cls,
        url:str|None = None,
        html:str|None = None,
        session:GSClient|None = None
        ) -> "GoogleScholar":
        # 该url并不是完整的url，只有后半部分
        # 通过url就会发送请求
        # 从url中获取soup
        if not session:
            logger.warning("未提供session,将使用默认session")
            session = GSClient()
        if url is not None:
            soup,html = session.get_page_soup(url)
        elif html:
            soup = BeautifulSoup(html, "html.parser")
        else:
            raise ValueError("url and html cannot both be set to None")
            
        html_rows = soup.find_all('div', class_='gs_r gs_or gs_scl') + soup.find_all('div', class_='gsc_mpat_ttl')
        if html_rows == []:
            raise GSRowError("未找到任何文章")
        # 删除一些没有data-cid的文章或者广告
        rows = [GSRow.from_row(row,session) for row in html_rows if row.get("data-cid")]
        param = url.split("?")[-1] if url else ""
        param_list = param.split("&")
        
        page_num = 1
        for param in param_list:
            if "start=" in param:
                page_num = int(int(param.split("=")[-1]) / 10 + 1)
                break
        html_next_url = None
        next_link = soup.find(class_='gs_ico gs_ico_nav_next')
        if next_link and next_link.parent and 'href' in next_link.parent.attrs:
            html_next_url = next_link.parent['href']
        
        if session.mirror == 1 and isinstance(html_next_url, str):
            next_url = html_next_url.replace("/extdomains/scholar.google.com","")
        else:
            next_url = None
        
        totle_results = cls._get_total_results(soup)
        return cls(
            url = url,
            session = session,
            html = html,
            soup = soup,
            rows = rows,
            param_list = param_list,
            page_num = page_num,
            next_url = next_url,
            totle_results = totle_results,
            )
        
    @classmethod
    def from_html(
        cls,
        html_path:str|Path,
        session:GSClient|None = None
        ) -> "GoogleScholar":
        if isinstance(html_path,str):
            html_path = Path(html_path)
            
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
            
        return cls.from_url(
            url = None,
            html = html,
            session = session
            )
        
    @classmethod
    def from_dict(cls,data:dict[str,Any],session:GSClient|None=None) -> "GoogleScholar":
        # 从字典中加载
        # 无soup和html
        url:str = data['url']
        rows:list[GSRow] = [GSRow.from_dict(row,session) for row in data["rows"]]
        next_url:str = data["next_url"]
        page_num:int = data["page_num"]
        totle_results:int = data["totle_results"]
        param_list:list[str] = data["param_list"]
        return cls(
            url = url,
            session = session,
            html = None,
            soup = None,
            rows = rows,
            param_list = param_list,
            page_num = page_num,
            next_url = next_url,
            totle_results = totle_results,
        )
    @classmethod
    def from_json(cls,json_path:str|Path,session:GSClient|None=None) -> "GoogleScholar":
        if isinstance(json_path,str):
            json_path = Path(json_path)

        with open(json_path, "r", encoding="utf-8") as f:
            page_dict = json.load(f)

        return cls.from_dict(
            data = page_dict,
            session = session,
        )
        
    @staticmethod
    def _get_total_results(soup:BeautifulSoup):
        if soup.find("div", class_="gs_pda"):
            return None

        for x in soup.find_all('div', class_='gs_ab_mdw'):
            # Accounting for different thousands separators:
            # comma, dot, space, apostrophe
            if "About" in x.text and "results" in x.text:
                # Example: "About 1,234 results (0.12 seconds)"
                match = re.match(pattern=r'(^|\s*About)\s*([0-9,\.\s’]+)', string=x.text)
                if match:
                    return int(re.sub(pattern=r'[,\.\s’]',repl='', string=match.group(2)))
        return 0
    
    def fill_all_bib(self):
        # 填充所有的row
        if self.rows is not None:
            for row in self.rows:
                if not row.filled:
                    row.load_bib()
    
    def __next__(self):
        # 下一个页面
        if self.next_url:
            return GoogleScholar.from_url(url = self.next_url, session = self.session)
        else:
            raise StopIteration
    
    def __iter__(self):
        return self
    
    @override
    def __repr__(self) -> str:
        # 打印对象
        str_rows = "\n".join([str(row) for row in self.rows]) if self.rows is not None else ""
        token = f"""
        URL: {self.url}
        Totle_results: {self.totle_results}
        Rows:\n{str_rows}
        """
        return token

    def export_json(self,json_path:str|Path,filled_all:bool = False):
        # 导出为json
        if filled_all:
            self.fill_all_bib()
        if isinstance(json_path,str):
            json_path = Path(json_path)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(self.dump_dict(), f, indent=4)
            
    def dump_json(self):
        # 导出为json
        return json.dumps(self.dump_dict(), indent=4)
    
    def dump_dict(self):
        # 导出为字典
        # 无soup和html

        page_dict = {
            "url":self.url,
            "totle_results":self.totle_results,
            "page_num":self.page_num,
            "next_url":self.next_url,
            "param_list":self.param_list,
            "rows":[row.dump_dict() for row in self.rows] if self.rows is not None else []
        }
        
        return page_dict   
    
    def export_html(self,html_path:str|Path):
        # 导出为html
        if not self.soup:
            logger.error("未找到soup,无法导出html")
            return
        if isinstance(html_path,str):
            html_path = Path(html_path)
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(self.soup.prettify())

class GSRow():
    """
    GoogleScholar中一个文章的对象
    
    GoogleScholar: 文章所在的GoogleScholar对象
    row: 文章的soup对象,class = gs_r gs_or gs_scl
    cid: 文章的cid
    pos: 文章在GoogleScholar中的位置
    title: 文章的标题
    pub_url: 文章的网页链接
    abstract: 文章的摘要
    author: 文章的作者
    publisher: 文章的出版社
    journal: 文章的期刊
    pub_type: 文章的类型:文章或者图书
    pub_year: 文章的发表年份
    url_scholarbib: 文章的bib链接(总的,有四种格式,其中一种是bib)
    num_citations: 文章的引用数
    cite_url: 文章的引用链接
    related_url: 与文章相关的链接
    pdf_url: 文章的pdf链接(如果有的话)
    filled: 文章的bib信息是否已经填充
    
    bib: 文章的bib信息
        title: 文章的标题
        author: 文章的作者
        journal: 文章的期刊
        volume: 文章的卷号
        number: 文章的期号
        pages: 文章的页码
        year: 文章的发表年份
        pulisher: 文章的出版社
    """
    def __init__(
        self,
        row: BeautifulSoup|None = None,
        session: GSClient|None = None,
        cid: str|None = None,
        pos: int|None = None,
        title: str|None = None,
        pub_url: str|None = None,
        abstract: str|None = None,
        author: list[str]|None = None,
        publisher: str|None = None,
        journal: str|None = None,
        pub_type: str|None = None,
        pub_year: str|None = None,
        url_scholarbib: str|None = None,
        num_citations: int|None = None,
        cite_url: str|None = None,
        related_url: str|None = None,
        pdf_url: str|None = None,
        filled: bool = False,
        bib: dict[str,str]|None = None,
        ) -> None:
        if not session:
            logger.warning("未提供session,将使用默认session")
            session = GSClient()
        self.row = row
        self.session = session
        self.cid = cid
        self.pos = pos
        self.title = title
        self.pub_url = pub_url
        self.abstract = abstract
        self.author = author
        self.publisher = publisher
        self.journal = journal
        self.pub_type = pub_type
        self.pub_year = pub_year
        self.url_scholarbib = url_scholarbib
        self.num_citations = num_citations
        self.cite_url = cite_url
        self.related_url = related_url
        self.pdf_url = pdf_url
        self.filled = filled
        self.bib = bib
        
    @classmethod
    def from_row(cls,row,session: GSClient) -> "GSRow":
        # 从row中加载信息
        row_dict = cls.load_information(row=row)
        cid:str = row_dict["cid"]
        pos:int = row_dict["pos"]
        title:str = row_dict["title"]
        pub_url:str = row_dict["pub_url"]
        abstract:str = row_dict["abstract"]
        author:list[str] = row_dict["author"]
        publisher:str = row_dict["publisher"]
        journal:str = row_dict["journal"]
        pub_type:str = row_dict["pub_type"]
        pub_year:str = row_dict["pub_year"]
        url_scholarbib:str = row_dict["url_scholarbib"]
        num_citations:int = row_dict["num_citations"]
        cite_url:str = row_dict["cite_url"]
        related_url:str = row_dict["related_url"]
        pdf_url:str = row_dict["pdf_url"]
        filled:bool = False
        bib:dict[str,str] = {}
        
        # fix_information
        if session.mirror == 0:
            pass
        elif session.mirror == 1:
            pop_str = "/extdomains/scholar.google.com"
            if (pop_str in cite_url) or (pop_str in related_url):
                cite_url = cite_url.replace(pop_str, "")
                related_url = related_url.replace(pop_str, "")
            else:
                print(f"Error url:{cid}_{title}: 请检查cite_url和related_url")
            if "javascript:void(0)" in pub_url:
                pub_url = ""
            if "javascript:void(0)" in pdf_url:
                pdf_url = ""
        else:
            print(f"Error mirror website")
        
        
        return cls(
            row = row,
            session = session,
            cid = cid,
            pos = pos,
            title = title,
            pub_url = pub_url,
            abstract = abstract,
            author = author,
            publisher = publisher,
            journal = journal,
            pub_type = pub_type,
            pub_year = pub_year,
            url_scholarbib = url_scholarbib,
            num_citations = num_citations,
            cite_url = cite_url,
            related_url = related_url,
            pdf_url = pdf_url,
            filled = filled,
            bib = bib,
        )
    
    @classmethod
    def from_dict(cls,data:dict[str,Any],session: GSClient|None) -> "GSRow":

        return cls(
            row = None,
            session = session,
            **data
        )
        
    @staticmethod
    def _get_authorlist(authorinfo:str) -> list[str]:
        authorlist:list[str] = []
        text = authorinfo.split(' - ')[0]
        for i in text.split(','):
            i = i.strip()
            if bool(re.search(r'\d', i)):
                continue
            if ("Proceedings" in i or "Conference" in i or "Journal" in i or
                    "(" in i or ")" in i or "[" in i or "]" in i or
                    "Transactions" in i):
                continue
            i = i.replace("…", "")
            authorlist.append(i)
        return authorlist

    @staticmethod
    def _extract_tag(text:str) -> str|None:
        """从形如 [TAG][X] 的文本中提取 TAG"""
        match = re.search(r'\[([A-Z]+)\]', text)
        if match:
            return match.group(1)  # 返回第一个匹配的括号内容
        return None
    
    @classmethod
    def load_information(cls,row:Tag) -> dict[str,Any]:
        """根据row加载信息"""
        row = row
        # databox是每一个文章的box而不是整个页面的box
        databox:Tag = row.find('div', class_='gs_ri')
        title = databox.find('h3', class_='gs_rt')
        
        if title.find('a'):
            pub_url:str = title.find('a')['href']
        else:
            pub_url = ""
        cid:str = row.get('data-cid')
        pos:int = row.get('data-rp')

        pub_type:str = None
        if title.find('span', class_='gs_ctu'):  # A citation
            title.span.extract()
        elif title.find('span', class_='gs_ctc'):  # A book or PDF
            span = title.span.extract()
            span_text = span.text
            tag = cls._extract_tag(span_text)
            if tag == 'BOOK':
                pub_type = 'BOOK'
            else:
                pub_type = 'ARTICLE'
        else:
            pub_type = 'ARTICLE'
        
        title:str = title.text.strip()
        # 提取作者等基本信息
        author_div_element = databox.find('div', class_='gs_a')
        authorinfo = author_div_element.text
        authorinfo = authorinfo.replace(u'\xa0', u' ')       # NBSP
        authorinfo = authorinfo.replace(u'&amp;', u'&')      # Ampersand
        author:list[str] = cls._get_authorlist(authorinfo)
        # 获取author_id
        # authorinfo_html = author_div_element.decode_contents()
        # self.author_id = self._get_author_id_list(authorinfo_html)

        # 该行有四种类型并且有一些信息(author/venue/year/host):
        #  (A) authors - host
        #  (B) authors - venue, year - host
        #  (C) authors - venue - host
        #  (D) authors - year - host
        venueyear = authorinfo.split(' - ')
        publisher:str = venueyear[-1].strip()
        journal:str = None
        pub_year:str = None
        # If there is no middle part (A) then venue and year are unknown.
        if len(venueyear) > 2:
            venueyear = venueyear[1].split(',')
            journal = None
            year = venueyear[-1].strip()
            if year.isnumeric() and len(year) == 4:
                pub_year = year
                if len(venueyear) >= 2:
                    journal = ','.join(venueyear[0:-1]) # everything but last
            else:
                journal = ','.join(venueyear) # everything
                pub_year = None
            journal = journal
        
        # abstract 有可能不全
        abstract:str = None
        if databox.find('div', class_='gs_rs'):
            abstract = databox.find('div', class_='gs_rs').text
            abstract = abstract.replace(u'\u2026', u'')
            abstract = abstract.replace(u'\n', u' ')
            abstract = abstract.strip()

            if abstract[0:8].lower() == 'abstract':
                abstract = abstract[9:].strip()


        # sclib指的是将该文章存入自己库的链接,需要整个页面的信息才能拿到，而GSRow只有单个文章的信息
        # sclib = row.find('div', id='gs_res_glb').get('data-sva').format(self.cid)
        # self.add_lib_url = sclib

        # bibcite url
        url_scholarbib:str = _BIBCITE.format(cid, pos)
        # cite and related
        lowerlinks = databox.find('div', class_='gs_fl').find_all('a')

        num_citations:int = 0
        cite_url:str = None
        related_url:str = None
        pdf_url:str = None
        for link in lowerlinks:
            if 'Cited by' in link.text:
                num_citations = int(re.findall(r'\d+', link.text)[0].strip())
                cite_url = link['href']

            if 'Related articles' in link.text:
                related_url = link['href']
        # pdf url
        if row.find('div', class_='gs_ggs gs_fl'):
            pdf_url = row.find('div', class_='gs_ggs gs_fl').a['href']
        return {
            "cid":cid,
            "pos":pos,
            "title":title,
            "pub_url":pub_url,
            "abstract":abstract,
            "author":author,
            "publisher":publisher,
            "journal":journal,
            "pub_type":pub_type,
            "pub_year":pub_year,
            "url_scholarbib":url_scholarbib,
            "num_citations":num_citations,
            "cite_url":cite_url,
            "related_url":related_url,
            "pdf_url":pdf_url,
        }
        
    def load_bib(self) -> None:
        if self.filled:
            return
        
        bibtex_url:str = self._get_bibtex(self.url_scholarbib)
        bibtex_url = bibtex_url.replace(self.session.base_url,"")
        if bibtex_url:
            # bibtex_url = self.session.base_url + bibtex_url
            _, bibtex_text = self.session.get_page_soup(bibtex_url.replace(self.session.base_url,""))
            parser = bibtexparser.bparser.BibTexParser(common_strings=True)
            parsed_bib:dict = self.remap_bib(bibtexparser.loads(bibtex_text,parser).entries[-1], _BIB_MAPPING, _BIB_DATATYPES)
            # author: str -> list
            parsed_bib_author:str = parsed_bib.pop('author')
            parsed_bib_author = parsed_bib_author.split(' and ')
            parsed_bib_author = [author.strip() for author in parsed_bib_author]
            parsed_bib.update({'author': parsed_bib_author})
            
            self.bib.update(parsed_bib)
            self.filled = True

    def _get_bibtex(self, bib_url) -> str:
        """Retrieves the bibtex url"""

        soup, _ = self.session.get_page_soup(bib_url)
        styles = soup.find_all('a', class_='gs_citi')

        for link in styles:
            if link.string.lower() == "bibtex":
                return link.get('href')
        return ''

    def export_Paper(self):
        """导出为Paper对象"""
        pass
    
    def export_json(self,json_path:str|Path) -> None:
        # 导出为json
        if isinstance(json_path,str):
            json_path = Path(json_path)

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(self.dump_dict(), f, indent=4)
            
    def dump_dict(self) -> dict:
        # 导出时以bib为优先
        paper_dict = self.__dict__.copy()
        paper_dict.pop("row")
        paper_dict.pop("session")

        # if self.filled:
        #     bib = paper_dict.pop("bib")
        #     paper_dict.update(bib)
        return paper_dict
    
    def dump_json(self) -> json:
        # 导出为json
        return json.dumps(self.dump_dict(), indent=4)
    
    @staticmethod
    def remap_bib(parsed_bib: dict, mapping: dict, data_types:dict ={}) -> dict:
        for key, value in mapping.items():
            if key in parsed_bib:
                parsed_bib[value] = parsed_bib.pop(key)

        for key, value in data_types.items():
            if key in parsed_bib:
                if value == 'int':
                    parsed_bib[key] = int(parsed_bib[key])

        return parsed_bib
    
    def __repr__(self) -> str:
        # 打印对象
        return f"GSRow({','.join(self.author)}-{self.pub_year}-{self.title}-{self.publisher})"
    
    # def __dict__(self):
    #     return self.__dict__
    
# class GoogleScholarParser():
#     """
#     给一个GoogleScholar返回的页面，解析出论文信息
#     """
#     def __init__(
#         self,
        
#         ) -> None:
#         pass
#     pass