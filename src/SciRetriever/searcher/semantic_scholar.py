"""
Semantic Scholar searcher implementation.
"""

import logging
from typing import Any

from ..model.paper import Paper
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
class SemanticScholarSearcher(BaseSearcher):
    """Implementation of BaseSearcher for Semantic Scholar."""
    
    def __init__(
        self,
        session:SemanticScholarClient,

        ):
        """
        Initialize the Semantic Scholar searcher.
        
        Args:
            api_key: API key for Semantic Scholar (optional)
        """
        # Get API key from config if not provided
        super().__init__(client=self.client)

        self.api_key = api_key
        self.client = SemanticScholarClient(api_key=api_key)
        logger.info("Initialized Semantic Scholar searcher")

    def search(
        self, 
        query: str, 
        limit: int = 10, 
        fields: list[str] | None = None, 
        **kwargs
    ) -> list[Paper]:
        pass

    def _convert_to_paper(self, data: dict[str, Any]) -> Paper:
        """Convert Semantic Scholar paper data to a Paper object."""
        # Extract DOI if available in externalIds
        doi = None
        if "externalIds" in data and data["externalIds"]:
            doi = data["externalIds"].get("DOI")
        
        # Extract authors
        authors = []
        if "authors" in data and data["authors"]:
            authors = [author.get("name", "") for author in data["authors"]]
        
        # Determine publisher/journal
        publisher = None
        journal = None
        if "venue" in data and data["venue"]:
            journal = data["venue"]
        
        # Extract fields of study as tags
        tags = []
        if "fieldsOfStudy" in data and data["fieldsOfStudy"]:
            tags = data["fieldsOfStudy"]
        
        return Paper(
            title=data.get("title", "Untitled"),
            authors=authors,
            abstract=data.get("abstract"),
            doi=doi,
            url=data.get("url"),
            publisher=publisher,
            year=data.get("year"),
            journal=journal,
            tags=tags,
            downloaded=False,
            metadata=data,
        )