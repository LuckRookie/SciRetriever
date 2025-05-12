"""
Google Scholar searcher implementation.
"""

import requests
import time
from typing import Dict, List, Optional, Union, Any

from scholarly import scholarly,ProxyGenerator
from bs4 import BeautifulSoup
from bibtexparser.bibdatabase import BibDatabase
import bibtexparser
import re
from ..models.paper import Paper
from ..network import NetworkClient, Proxy
from ..utils.exceptions import SearchError, RateLimitError
from ..utils.logging import get_logger
from .searcher import BaseSearcher

__GoogleScholar = [
    "https://scholar.google.com"
    "https://scholar.aigrogu.com"
]

logger = get_logger(__name__)

_SCHOLARPUBRE = r'cites=([\d,]*)'
_CITATIONPUB = '/citations?hl=en&view_op=view_citation&citation_for_view={0}'
_SCHOLARPUB = '/scholar?hl=en&oi=bibs&cites={0}'
_CITATIONPUBRE = r'citation_for_view=([\w-]*:[\w-]*)'
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
class GSClint():
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
        use_proxy: bool = False,
        proxy:Proxy = None,
        mirror:int = 0,
        ) -> None:
        self.session = NetworkClient(use_proxy = use_proxy,proxy=proxy)
        self.mirror = mirror
        self.base_url = __GoogleScholar[self.mirror]

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
                cookie = {
                    'google_verify_data': verify_data
                }
                # 手动设置cookie
                self.session.update_cookie(cookie=cookie)

                # 等待一小段时间模拟浏览器行为
                time.sleep(1)
                
                # 再次请求
                response = self.session.get(url=url)
        # 处理响应
        if response.status_code == 200:
            return response


    def get_page_soup(self,scholar_url):

        url = self.base_url + scholar_url
        response = self.session.get(url=url)
        

        if self.mirror == 1:
            response = self._get_mirror_response(url = url,response = response)
            soup = BeautifulSoup(response.text, "html.parser")
            return soup,response.text

        else:
            soup = BeautifulSoup(response.text, "html.parser")
            return soup,response.text

class GoogleScholarSearcher(BaseSearcher):
    """Implementation of BaseSearcher for Google Scholar."""
    
    def __init__(
        self,
        client: NetworkClient = NetworkClient(),
        parser: GoogleScholarParser = GoogleScholarParser(),
        ):
        """
        Initialize the Google Scholar searcher.
        
        Args:
            api_key: Not used for scholarly library, but kept for consistency
        """
        super().__init__(client=client)
        
        self._configure_scholarly()
        logger.info("Initialized Google Scholar searcher")
        
        self.parser = parser
    
    def _configure_scholarly(self):
        """Configure scholarly library settings."""
        # This method can be extended to configure proxies or other settings
        # scholarly.use_proxy(...)
        self.scholarly = scholarly
        
        if self.client.proxy:
            logger.info(f"Setting proxy for scholarly: {self.client.proxy}")
            proxy = self.client.proxy.get_proxies()
            pg1 = ProxyGenerator()
            pg2 = ProxyGenerator()
            
            success1 = pg1.SingleProxy(http=proxy['http'])
            success2 = pg2.SingleProxy(http=proxy['http'])
            if success1 and success2:
                logger.info("Successfully set proxies for scholarly")
                self.scholarly.use_proxy(pg1,pg2)
            else:
                logger.warning("Failed to set proxies for scholarly")

    def search(
        self, 
        query: str, 
        limit: int = 10, 
        fields: Optional[List[str]] = None, 
        **kwargs
    ) -> List[Paper]:
        """
        Google Scholar搜索的通用方法
        
        Args:
            query: 搜索的关键词
            limit: 默认限制返回的文献数量,设置为0则不限制
            fields: 默认不用
            **kwargs: 附加参数:
                year_start: 起始日期
                year_end: 结束日期
                
        Returns:
            返回一个Paper对象列表(暂定)
            
        Raises:
            SearchError: If the search fails
        """
        logger.info(f"Searching Google Scholar for: {query}")
        
        year_start = kwargs.get('year_start')
        year_end = kwargs.get('year_end')
        
        # Build the query with year filters if provided
        full_query = query
        if year_start and year_end:
            logger.info(f"Filtering by year range: {year_start} to {year_end}")
            full_query = f"{query} year_lo:{year_start} year_hi:{year_end}"
        elif year_start:
            logger.info(f"Filtering by start year: {year_start}")
            full_query = f"{query} year_lo:{year_start}"
        elif year_end:
            logger.info(f"Filtering by end year: {year_end}")
            full_query = f"{query} year_hi:{year_end}"
        
        papers = []
        try:
            search_query = self.scholarly.search_pubs(full_query)
            
            # Collect the specified number of results
            for _ in range(limit):
                try:
                    pub = next(search_query)
                    papers.append(self._convert_to_paper(pub))
                    # Add a small delay to avoid being blocked
                    time.sleep(1)
                except StopIteration:
                    logger.info("No more results from Google Scholar")
                    break
                except Exception as e:
                    logger.error(f"Error processing publication: {e}")
                    continue
            
            logger.info(f"Found {len(papers)} papers on Google Scholar")
            return papers
            
        except Exception as e:
            logger.error(f"Error searching Google Scholar: {e}")
            raise SearchError(f"Failed to search Google Scholar: {e}")
    
    def get_citations(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
        """
        获取引用改文献的其他论文
        
        Args:
            paper: A Paper object or DOI string
            limit: Maximum number of results to return

        Returns:
            A list of Paper objects
        """
        if isinstance(paper, str):
            # If only DOI is provided, try to get the paper first
            paper_obj = self.get_paper_by_doi(paper)
            if not paper_obj or 'cluster_id' not in paper_obj.metadata:
                logger.error(f"Could not find paper with DOI: {paper}")
                raise SearchError(f"Could not find paper with DOI: {paper}")
            cluster_id = paper_obj.metadata.get('cluster_id')
        else:
            if 'cluster_id' not in paper.metadata:
                logger.error("Paper object does not contain Google Scholar cluster_id")
                raise SearchError("Paper object does not contain Google Scholar cluster_id")
            cluster_id = paper.metadata.get('cluster_id')
        
        logger.info(f"Retrieving citations for cluster_id: {cluster_id}")
        try:
            citations = []
            citation_query = scholarly.get_citedby(cluster_id)
            
            for _ in range(limit):
                try:
                    citation = next(citation_query)
                    citations.append(self._convert_to_paper(citation))
                    # Add a small delay to avoid being blocked
                    time.sleep(1)
                except StopIteration:
                    logger.info("No more citation results")
                    break
                except Exception as e:
                    logger.error(f"Error processing citation: {e}")
                    continue
            
            logger.info(f"Found {len(citations)} citations")
            return citations
            
        except Exception as e:
            logger.error(f"Error retrieving citations: {e}")
            raise SearchError(f"Failed to retrieve citations for {cluster_id}: {e}")
    
    def get_references(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
        """
        获取该文献引用的论文的信息

        Args:
            paper: A Paper object or DOI string
            limit: Maximum number of results to return
            
        Returns:
            A list of Paper objects
        """
        logger.warning("Google Scholar doesn't support retrieving references directly")
        return []
    
    def _convert_to_paper(self, data: Dict[str, Any]) -> Paper:
        """将获取到的页面转化为Paper类型"""
        # Extract authors
        authors = []
        if "bib" in data and "author" in data["bib"]:
            authors = data["bib"]["author"]
        
        # Extract year
        year = None
        if "bib" in data and "pub_year" in data["bib"]:
            try:
                year = int(data["bib"]["pub_year"])
            except (ValueError, TypeError):
                pass
        
        # Extract journal/venue
        journal = None
        if "bib" in data and "venue" in data["bib"]:
            journal = data["bib"]["venue"]
        
        # Extract title
        title = "Untitled"
        if "bib" in data and "title" in data["bib"]:
            title = data["bib"]["title"]
        
        # Extract abstract (Google Scholar often doesn't provide this)
        abstract = None
        if "bib" in data and "abstract" in data["bib"]:
            abstract = data["bib"]["abstract"]
        
        
        # # Extract DOI from URL if available
        # doi = None
        # if "pub_url" in data:
        #     url = data["pub_url"]
        #     # Try to extract DOI from URL
        #     if "doi.org/" in url:
        #         doi = url.split("doi.org/")[-1]
        
        # # Also check for DOI in the bib data
        # if not doi and "bib" in data and "doi" in data["bib"]:
        #     doi = data["bib"]["doi"]
        
        return Paper(
            title=title,
            authors=authors,
            abstract=abstract,
            doi=doi,
            url=data.get("pub_url"),
            publisher=None,  # Google Scholar doesn't provide publisher info
            year=year,
            journal=journal,
            tags=[],  # Google Scholar doesn't provide tags/fields
            downloaded=False,
            metadata=data,
        )
    @staticmethod
    def _build_url(baseurl: str, patents: bool = True,
                    citations: bool = True, year_low: int = None,
                    year_high: int = None, sort_by: str = "relevance",
                    include_last_year: str = "abstracts",
                    start_index: int = 0
                    )-> str:
        """build URL of google scholar from requested parameters."""
        url = baseurl

        yr_lo = '&as_ylo={0}'.format(year_low) if year_low is not None else ''
        yr_hi = '&as_yhi={0}'.format(year_high) if year_high is not None else ''
        citations = '&as_vis={0}'.format(1 - int(citations))
        patents = '&as_sdt={0},33'.format(1 - int(patents))
        sortby = ''
        start = '&start={0}'.format(start_index) if start_index > 0 else ''

        if sort_by == "date":
            if include_last_year == "abstracts":
                sortby = '&scisbd=1'
            elif include_last_year == "everything":
                sortby = '&scisbd=2'
            else:
                logger.debug("Invalid option for 'include_last_year', available options: 'everything', 'abstracts'")
                return
        elif sort_by != "relevance":
            logger.debug("Invalid option for 'sort_by', available options: 'relevance', 'date'")
            return

        # improve str below
        return url + yr_lo + yr_hi + citations + patents + sortby + start

    def search_publication(self,query:str = None,patents: bool = True,
                            citations: bool = True, year_low: int = None,
                            year_high: int = None, sort_by: str = "relevance",
                            include_last_year: str = "abstracts",
                            start_index: int = 0
                            )-> str:
        params = {
            "q": query,
        }

        url = self.base_url 

        return response
        
class Total_GoogleScholar():
    """
    Google Scholar的总对象,针对每一次查询
    """
    def __init__(
        self,
        response: requests.Response,
        session: GSClint,
        ) -> None:
        if not response:
            raise "ERROR: 请提供response"

        self.soup = BeautifulSoup(response.text, "html.parser")
        self.url = response.url
        # 文章的rows

class GoogleScholar():
    """
    Google Scholar的页面对象
    """
    def __init__(
        self,
        url:str,
        session: GSClint,
        ) -> None:
        if not url:
            raise "ERROR: 请提供url"

        self.soup,self.html = session.get_page_soup(url)
        self.url = url
        self.session = session
        # 文章的rows
        self.rows = self.soup.find_all('div', class_='gs_r gs_or gs_scl') + self.soup.find_all('div', class_='gsc_mpat_ttl')
        # 删除一些没有data-cid的文章或者广告
        self.rows = [GSRow(row) for row in self.rows if row.get("data-cid")]

        # 下一页的按钮
        self.next = self.soup.find(class_='gs_ico gs_ico_nav_next')
        self.totle_results = self._get_total_results()
        
        
    def _get_total_results(self):
        if self.soup.find("div", class_="gs_pda"):
            return None

        for x in self.soup.find_all('div', class_='gs_ab_mdw'):
            # Accounting for different thousands separators:
            # comma, dot, space, apostrophe
            match = re.match(pattern=r'(^|\s*About)\s*([0-9,\.\s’]+)', string=x.text)
            if match:
                return int(re.sub(pattern=r'[,\.\s’]',repl='', string=match.group(2)))
        return 0
    
    def __next__(self):
        # 下一个页面
        if self.next:
            next_url = self.next.get("href")
            return GoogleScholar(next_url, self.session)
        else:
            raise StopIteration
    
    def __iter__(self):
        return self
        
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
    bib: 文章的bib信息
    filled: 文章的bib信息是否已经填充
    """
    def __init__(
        self,
        row: BeautifulSoup,
        session: GSClint,
        ) -> None:
        self.row = row
        self.session = session
        self.load_information()
        self.filled = False
        self.bib = {}
        
    @staticmethod
    def _get_authorlist(authorinfo):
        authorlist = list()
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
    def _extract_tag(text):
        """从形如 [TAG][X] 的文本中提取 TAG"""
        match = re.search(r'\[([A-Z]+)\]', text)
        if match:
            return match.group(1)  # 返回第一个匹配的括号内容
        return None

    def load_information(self):
        """根据row加载信息"""
        row = self.row
        # databox是每一个文章的box而不是整个页面的box
        databox = row.find('div', class_='gs_ri')
        title = databox.find('h3', class_='gs_rt')
        if title.find('a'):
            self.pub_url = title.find('a')['href']
        self.cid = row.get('data-cid')
        self.pos = row.get('data-rp')

        if title.find('span', class_='gs_ctu'):  # A citation
            title.span.extract()
        elif title.find('span', class_='gs_ctc'):  # A book or PDF
            span = title.span.extract()
            span_text = span.text
            tag = self._extract_tag(span_text)
            if tag == 'BOOK':
                self.pub_type = 'BOOK'
            else:
                self.pub_type = 'ARTICLE'
        else:
            self.pub_type = 'ARTICLE'
        
        self.title = title.text.strip()
        # 提取作者等基本信息
        author_div_element = databox.find('div', class_='gs_a')
        authorinfo = author_div_element.text
        authorinfo = authorinfo.replace(u'\xa0', u' ')       # NBSP
        authorinfo = authorinfo.replace(u'&amp;', u'&')      # Ampersand
        self.author = self._get_authorlist(authorinfo)
        # 获取author_id
        # authorinfo_html = author_div_element.decode_contents()
        # self.author_id = self._get_author_id_list(authorinfo_html)

        # 该行有四种类型并且有一些信息(author/venue/year/host):
        #  (A) authors - host
        #  (B) authors - venue, year - host
        #  (C) authors - venue - host
        #  (D) authors - year - host
        venueyear = authorinfo.split(' - ')
        self.publisher = venueyear[-1].strip()
        # If there is no middle part (A) then venue and year are unknown.
        if len(venueyear) <= 2:
            self.journal, self.pub_year = None, None
        else:
            venueyear = venueyear[1].split(',')
            journal = None
            year = venueyear[-1].strip()
            if year.isnumeric() and len(year) == 4:
                self.pub_year = year
                if len(venueyear) >= 2:
                    journal = ','.join(venueyear[0:-1]) # everything but last
            else:
                journal = ','.join(venueyear) # everything
                self.pub_year = None
            self.journal = journal
        
        # abstract 有可能不全
        if databox.find('div', class_='gs_rs'):
            self.abstract = databox.find('div', class_='gs_rs').text
            self.abstract = self.abstract.replace(u'\u2026', u'')
            self.abstract = self.abstract.replace(u'\n', u' ')
            self.abstract = self.abstract.strip()

            if self.abstract[0:8].lower() == 'abstract':
                self.abstract = self.abstract[9:].strip()


        # sclib指的是将该文章存入自己库的链接,需要整个页面的信息才能拿到，而GSRow只有单个文章的信息
        # sclib = row.find('div', id='gs_res_glb').get('data-sva').format(self.cid)
        # self.add_lib_url = sclib

        # bibcite url
        self.url_scholarbib = _BIBCITE.format(self.cid, self.pos)
        # cite and related
        lowerlinks = databox.find('div', class_='gs_fl').find_all('a')

        self.num_citations = 0
        self.cite_url = None
        self.related_url = None
        self.pdf_url = None
        for link in lowerlinks:
            if 'Cited by' in link.text:
                self.num_citations = int(re.findall(r'\d+', link.text)[0].strip())
                self.cite_url = link['href']

            if 'Related articles' in link.text:
                self.related_url = link['href']
        # pdf url
        if row.find('div', class_='gs_ggs gs_fl'):
            self.pdf_url = row.find('div', class_='gs_ggs gs_fl').a['href']
    
    def load_bib(self):
        if self.filled:
            return
        
        bibtex_url = self._get_bibtex(self.url_scholarbib)
        if bibtex_url:
            bibtex_url = self.session.base_url + bibtex_url
            _, bibtex_text = self.session.get_page_soup(bibtex_url)
            parser = bibtexparser.bparser.BibTexParser(common_strings=True)
            parsed_bib = self.remap_bib(bibtexparser.loads(bibtex_text,parser).entries[-1], _BIB_MAPPING, _BIB_DATATYPES)
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

    @staticmethod
    def remap_bib(parsed_bib: dict, mapping: dict, data_types:dict ={}) -> Dict:
        for key, value in mapping.items():
            if key in parsed_bib:
                parsed_bib[value] = parsed_bib.pop(key)

        for key, value in data_types.items():
            if key in parsed_bib:
                if value == 'int':
                    parsed_bib[key] = int(parsed_bib[key])

        return parsed_bib
    

# class GoogleScholarParser():
#     """
#     给一个GoogleScholar返回的页面，解析出论文信息
#     """
#     def __init__(
#         self,
        
#         ) -> None:
#         pass
#     pass