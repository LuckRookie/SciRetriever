"""
Semantic Scholar searcher implementation.
"""

import logging
from typing import Any
import requests
from enum import Enum

from ..model.paper import PaperMetadata
from ..database.model import Paper
from ..network import NetworkClient, Proxy
from ..utils.config import get_config
from ..utils.exceptions import SearchError
from ..utils.logging import get_logger
from .searcher import BaseSearcher

logger = get_logger(__name__)
"""
https://www.semanticscholar.org/product/api
申请api key.Semanticscholar的速率限制为1秒1次
"""
class SemanticScholarClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理Semantic Scholar网络请求的客户端
    仅接受网址后面的,而不需要全部网址
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
        headers = {
            "x-api-key":api_key,
        }
        self.update_headers(headers)

        self.graph_url:str = "https://api.semanticscholar.org/graph/v1"
        self.recommendations_url:str = "https://api.semanticscholar.org/recommendations/v1"
        self.datasets_url:str = "https://api.semanticscholar.org/datasets/v1"

    def get_search(
        self,
        query:str,
        fields:str | None = None,
        publicationTypes:str | None = None,
        openAccessPdf: bool | None = None,
        publicationDateOrYear: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> "SemanticScholarSearch":
        """
        最多只能返回 1,000 个按相关性排序的结果。对于更大的查询，请查看"/search/bulk"或数据集 API。
        每次最多只能返回 10 MB 的数据。
        
        query: 搜索查询字符串,不支持逻辑匹配,SematicScholar会根据相关性搜索
        
        fields: 要返回的字段列表. 默认为None.
                例如: fields="title,abstract,authors,year,journal,volume,issue,pages,doi,url,publisher"

                字段列表：
                paperId,
                corpusId,
                externalIds,
                url,
                title,
                abstract,
                venue,
                publicationVenue,
                year,
                referenceCount,
                citationCount,
                influentialCitationCount,
                isOpenAccess,
                openAccessPdf,
                fieldsOfStudy,
                s2FieldsOfStudy,
                publicationTypes,
                publicationDate,
                journal,
                citationStyles,
                authors,
        
        publicationTypes: 出版物类型列表.
                        Review  评论
                        JournalArticle  期刊文章
                        CaseReport  病例报告
                        ClinicalTrial  临床试验
                        Conference  会议
                        Dataset  数据集
                        Editorial  编辑
                        LettersAndComments  通信与评论
                        MetaAnalysis  元分析
                        News 新闻
                        Study 研究
                        Book  书
                        BookSection  书的章节
                        
                        使用逗号分隔的列表来包含任何列出的出版类型的论文。
                        示例：Review,JournalArticle 将返回出版类型为 Review 和/或 JournalArticle 的论文。
        openAccessPdf: 是否仅包含公开论文
        publicationDateOrYear: 出版物日期或年份. 将结果限制在给定的出版日期或年份范围内（包含）。接受格式 <startDate>:<endDate>，每个日期使用 YYYY-MM-DD 格式。
                        示例：
                            "2019-03-05" 2019 年 3 月 5 日
                            "2019-03" 在 2019 年 3 月
                            "2019" 在 2019 年
                            "2016-03-05:2020-06-06" 从 2016 年 3 月 5 日到 2020 年 6 月 6 日
                            "1981-08-25:" 1981 年 8 月 25 日或之后
                            ":2015-01" 在 2015 年 1 月 31 日之前或当天
                            "2015:2020" 在 2015 年 1 月 1 日至 2020 年 12 月 31 日之间
        """
        if not fields:
            fields = "paperId,corpusId,externalIds,url,title,abstract,venue,publicationVenue,year,referenceCount,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate,journal,citationStyles,authors"
        if not publicationTypes:
            publicationTypes = "Review,JournalArticle,Book,BookSection"
        params = {
            'query': query,
            'fields': fields,
            'publicationTypes': publicationTypes,
            'openAccessPdf': openAccessPdf,
            'publicationDateOrYear': publicationDateOrYear,
            'offset': offset,
            'limit': limit,
        }
        response = self.get(
            url=f"{self.graph_url}/paper/search",
            params=params,
        )
        return SemanticScholarSearch.from_search(response,params,self)
    def get_bulk(
        self,
        query:str,
        fields:str | None = None,
        token:str | None = None,
        publicationTypes:str | None = None,
        openAccessPdf: bool | None = None,
        publicationDateOrYear: str | None = None, 
    ) -> "SemanticScholarSearch":
        """
        此方法最多可以获取 1000 万篇论文。对于更大的需求，请使用数据集 API 来检索语料库的完整副本。
        
        query: 搜索查询字符串,支持逻辑匹配
                + for AND operation
                | for OR operation
                - negates a term
                " collects terms into a phrase
                * can be used to match a prefix
                ( and ) for precedence
                ~N after a word matches within the edit distance of N (Defaults to 2 if N is omitted)
                ~N after a phrase matches with the phrase terms separated up to N terms apart (Defaults to 2 if N is omitted)
                
                Examples:
                fish ladder matches papers that contain "fish" and "ladder"
                fish -ladder matches papers that contain "fish" but not "ladder"
                fish | ladder matches papers that contain "fish" or "ladder"
                "fish ladder" matches papers that contain the phrase "fish ladder"
                (fish ladder) | outflow matches papers that contain "fish" and "ladder" OR "outflow"
                fish~ matches papers that contain "fish", "fist", "fihs", etc.
                "fish ladder"~3 mathces papers that contain the phrase "fish ladder" or "fish is on a ladder"
                
        除了token其他与get_search相同
        """
        if not fields:
            fields = "paperId,corpusId,externalIds,url,title,abstract,venue,publicationVenue,year,referenceCount,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate,journal,citationStyles,authors"
        if not publicationTypes:
            publicationTypes = "Review,JournalArticle,Book,BookSection"
        params = {
            'query': query,
            'fields': fields,
            'publicationTypes': publicationTypes,
            'openAccessPdf': openAccessPdf,
            'publicationDateOrYear': publicationDateOrYear,
            'token': token,
        }
        
        response = self.get(
            url=f"{self.graph_url}/paper/search/bulk",
            params=params,
        )
        return SemanticScholarSearch.from_bulk(response,params,self)

class SearchMode(Enum):
    BULK = "bulk"
    SEARCH = "search"
    
class SemanticScholarSearch():
    """Implementation of BaseSearcher for Semantic Scholar."""
    
    def __init__(
        self,
        session:SemanticScholarClient,
        params:dict[str,str],
        datas:list[dict[str,Any]]|None=None,
        total_results:int|None=None,
        mode: SearchMode = SearchMode.SEARCH,
        # --- Bulk 模式专用参数 ---
        token: str | None = None,
        # --- Search 模式专用参数 ---
        offset: int = 0,
        limit: int = 100,
        ):
        """
        Initialize the Semantic Scholar searcher.
        
        Args:
            session: Semantic Scholar client session
        """
        self.base_url = "https://api.semanticscholar.org/graph/v1/paper/search/bulk"
        self.params = params
        self.datas = datas
        self.client = session
        self.total_results = total_results if total_results else 0
        
        self.mode = mode
        # 状态控制
        self.token = token
        self.offset = offset
        self.limit = limit
        
        # 动态设置 URL
        if self.mode == SearchMode.BULK:
            self.base_url = f"{self.client.graph_url}/paper/search/bulk"
        else:
            self.base_url = f"{self.client.graph_url}/paper/search"
        
        
        logger.info(f"SemanticScholarSearch initialized. Mode: {self.mode.value}, Total: {self.total_results}")
    def __len__(self):
        return len(self.datas) if self.datas else 0
    def __iter__(self):
        return self
    
    def __next__(self):
        # ================= Bulk 模式迭代逻辑 =================
        if self.mode == SearchMode.BULK:
            # 如果没有 token，说明上一页已经是最后一页（或者初始就没有 token 且这是第二次调用）
            if not self.token:
                raise StopIteration
            
            # 更新参数
            self.params.update({"token": self.token})
            
            # 发送请求
            response = self.client.get(self.base_url, params=self.params)
            
            # 返回新的实例（包含下一批数据和下一个 token）
            return self.from_bulk(response, self.params, self.client)
        
        # ================= Search 模式迭代逻辑 =================
        elif self.mode == SearchMode.SEARCH:
            # 计算下一个偏移量
            next_offset = self.offset + self.limit
            
            # 终止条件 1: 偏移量超过总数
            if next_offset >= self.total_results:
                raise StopIteration
            
            # 终止条件 2: 偏移量超过 API 限制 (通常 Search API 限制 offset 1000 或 10000)
            # 这里可以加个硬编码保护，或者依赖 API 报错
            if next_offset >= 1000: 
                logger.warning("Reached Semantic Scholar Search API offset limit.")
                raise StopIteration

            # 更新参数
            self.params.update({"offset": next_offset})
            
            # 发送请求
            response = self.client.get(self.base_url, params=self.params)
            
            # 检查是否返回了空数据 (有时 total 很大但后面没数据了)
            data_json = response.json()
            if not data_json.get('data'):
                raise StopIteration

            # 返回新的实例
            return self.from_search(response, self.params, self.client)
        
        else:
            raise StopIteration
    @classmethod
    def from_bulk(cls,response: requests.Response,params:dict[str,str],client:SemanticScholarClient):
        
        data = response.json()
        items = data.get('data', [])
        total_results = data.get('total')
        next_token = data.get('token')
        return cls(
            session=client,
            params=params,
            datas=items,
            total_results=total_results,
            mode=SearchMode.BULK,
            token=next_token,
        )
    @classmethod
    def from_search(cls,response: requests.Response,params:dict[str,str],client:SemanticScholarClient):
        
        data = response.json()
        items = data.get('data', [])
        total_results = data.get('total')
        # 从 params 或 response 中恢复当前状态
        current_offset = int(params.get('offset', 0))
        current_limit = int(params.get('limit', 100))
        return cls(
            session=client,
            params=params,
            datas=items,
            total_results=total_results,
            mode=SearchMode.SEARCH,
            offset=current_offset, # 存入 offset
            limit=current_limit    # 存入 limit
        )
    def data2papers(self,data:dict[str,Any]) -> PaperMetadata:
        """
        Convert a data item to a PaperMetadata object.
        
        Args:
            data: A dictionary containing paper metadata.
        
        Returns:
            A PaperMetadata object.
        """
        data_journal = data.get("journal",{})
        data_externalIds = data.get("externalIds",{})
        data_publicationVenue = data.get("publicationVenue",{})
        data_openAccessPdf = data.get("openAccessPdf",{})
        
        title = data.get("title","")
        authors = self.get_authors(data.get("authors",[]))
        abstract = data.get("abstract")
        doi = data_externalIds.get("DOI") if data_externalIds else None
        url = data_openAccessPdf.get("url") if data["isOpenAccess"] else None
        publisher = data_publicationVenue.get("name") if data_publicationVenue else None
        pub_year = data.get("year",None)
        journal = data_journal.get("name",None) if data_journal else None
        volume = data_journal.get("volume",None) if data_journal else None
        issue = data_journal.get("issue",None) if data_journal else None
        pages = data_journal.get("page",None) if data_journal else None
        keywords = None
        paper_metadata = data
        types = data.get("publicationTypes")[0]
        source = "Semantic Scholar"
        
        pdf_downloaded = False
        pdf_path = None
        pdf_url = data_openAccessPdf.get("url") if data["isOpenAccess"] else None
        citations_num = data.get("citationCount",0)
        notes = None
        references = None
        citations = None

        return PaperMetadata(
            title=title,
            authors=authors,
            abstract=abstract,
            doi=doi,
            url=url,
            publisher=publisher,
            pub_year=pub_year,
            journal=journal,
            volume=volume,
            issue=issue,
            pages=pages,
            keywords=keywords,
            paper_metadata=paper_metadata,
            type=types,
            source=source,
            pdf_downloaded=pdf_downloaded,
            pdf_path=pdf_path,
            pdf_url=pdf_url,
            citations_num=citations_num,
            notes=notes,
            references=references,
            citations=citations,
        )
    def get_authors(self,authors:list[dict[str,str]]) -> list[str]:
        return [
            author.get("name","") for author in authors
        ]
        
    def export_papers(self)->list[PaperMetadata]:
        """
        导出论文列表
        """
        papers:list[PaperMetadata] = [self.data2papers(paper) for paper in self.datas] if self.datas else []
        return papers
