"""
Semantic Scholar searcher implementation.
"""

import logging
from typing import Any
import requests

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

    额外参数：
        mirror: 镜像网站,0为官方网站
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
        publicationTypes:str | None = None,
        openAccessPdf: bool | None = None,
        publicationDateOrYear: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ):
        """
        query: 搜索查询字符串
        publicationTypes: 出版物类型列表.
                                Review  评论
                                JournalArticle  期刊文章
                                CaseReport  病例报告
                                ClinicalTrial  临床试验
                                Conference  会议
                                Dataset  数据集
                                Editorial  编辑
                                LettersAndComments  通信与评论
                                MetaAnalysis
                                News 新闻
                                Study 研究
                                Book  书
                                BookSection  书的章节
        openAccessPdf: 是否仅包含公开论文
        publicationDateOrYear: 出版物日期或年份. 格式为YYYY-MM-DD或YYYY.
        offset: 偏移量,用于分页查询. 默认为0.
        limit: 每页返回的最大结果数. 默认为100. 最大为100.
        """
        params = {
            'query': query,
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
        return response
    def get_bulk(
        self,
        query:str,
        fields:str | None = None,
        token:str | None = None,
        publicationTypes:str | None = None,
        openAccessPdf: bool | None = None,
        publicationDateOrYear: str | None = None, 
    ) -> "SemanticScholarBulk":
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
                        MetaAnalysis
                        News 新闻
                        Study 研究
                        Book  书
                        BookSection  书的章节
        openAccessPdf: 是否仅包含公开论文
        publicationDateOrYear: 出版物日期或年份. 格式为YYYY-MM-DD或YYYY.
        """
        if not fields:
            fields = "paperId,corpusId,externalIds,url,title,abstract,venue,publicationVenue,year,referenceCount,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate,journal,citationStyles,authors"
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
        return SemanticScholarBulk.from_bulk(response,params,self)
class SemanticScholarBulk():
    """Implementation of BaseSearcher for Semantic Scholar."""
    
    def __init__(
        self,
        session:SemanticScholarClient,
        params:dict[str,str],
        token:str | None = None,
        datas:list[dict[str,Any]]|None=None,
        total_results:int|None=None,
        ):
        """
        Initialize the Semantic Scholar searcher.
        
        Args:
            session: Semantic Scholar client session
        """
        self.base_url = "https://api.semanticscholar.org/graph/v1/paper/search/bulk"
        self.params = params
        self.token = token
        self.datas = datas
        self.client = session
        self.total_results = total_results if total_results else 0
        logger.info(f"SemanticScholarBulk total_results:{self.total_results}")
    def __len__(self):
        if self.datas is None:
            return 0
        return len(self.datas)
    def __iter__(self):
        return self
    
    def __next__(self):
        if self.token:
            self.params.update({"token":self.token})
            next_response = self.client.get(self.base_url,params=self.params)
            return self.from_bulk(next_response,self.params,self.client)
    
    @classmethod
    def from_bulk(cls,response: requests.Response,params:dict[str,str],client:SemanticScholarClient):
        
        data = response.json()['data']
        items = data.get('data', [])
        total_results = data.get('total')
        next_token = data.get('token')
        return cls(
            session=client,
            params=params,
            token=next_token,
            datas=items,
            total_results=total_results,
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
        
        title = data.get("title")
        authors = self.get_authors(data.get("author",[]))
        abstract = data.get("abstract")
        doi = data_externalIds.get("doi")
        url = data_openAccessPdf.get("url") if data["isOpenAccess"] else None
        publisher = data_publicationVenue.get("name")
        pub_year = data.get("year",None)
        journal = data_journal.get("name",None)
        volume = data_journal.get("volume",None)
        issue = data_journal.get("issue",None)
        pages = data_journal.get("page",None)
        keywords = None
        paper_metadata = data
        type = data.get("type")
        source = data.get("source")
        
        pdf_downloaded = False
        pdf_path = None
        download_data = None
        pdf_url = None
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
            type=type,
            source=source,
            pdf_downloaded=pdf_downloaded,
            pdf_path=pdf_path,
            pdf_url=pdf_url,
            citations_num=citations_num,
            notes=notes,
            references=references,
            citations=citations,
        )
    def get_authors(self,authors:list[dict[str,Any]]) -> list[str]:
        return [
            author.get("name") for author in authors
        ]
        
    def export_papers(self)->list[PaperMetadata]:
        """
        导出论文列表
        """
        papers:list[PaperMetadata] = [self.data2papers(paper) for paper in self.datas] if self.datas else []
        return papers
