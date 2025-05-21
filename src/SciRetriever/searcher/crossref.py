import requests
import time
from typing import Dict, List, Optional, Union, Any

from scholarly import scholarly,ProxyGenerator
from bs4 import BeautifulSoup
from bibtexparser.bibdatabase import BibDatabase
import bibtexparser
import re
from ..models.paper import Paper
from ..network import NetworkClient, Proxy, RateLimiter
from ..utils.exceptions import SearchError, RateLimitError,SciRetrieverError
from ..utils.logging import get_logger,setup_logging
from .searcher import BaseSearcher
from pathlib import Path



class CRClient(NetworkClient):
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
        email:str = None,
        rate_limit:Optional[RateLimiter] = None,
        max_retries:Optional[int] = None,
        retry_delay:Optional[float] = None,
        timeout:Optional[float] = None,
        user_agent: Optional[str] = None,
        use_proxy: bool = False,
        proxy:Optional[Proxy]=None,
        headers: Optional[Dict[str, str]] = None,
        allow_redirects: bool = True,
        cookie: Optional[Dict[str, str]] = None,
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
        self.email = email
        self.base_url = "https://api.crossref.org"
        self.default_headers.update({"mailto ":self.email})
        self.session = self._create_session()
        
    def get_work(self):
        pass
