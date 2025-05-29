
from typing import Any
from collections.abc import Generator

import requests
from ..models.paper import Paper
from ..network import NetworkClient, Proxy
from ..utils.exceptions import SearchError, RateLimitError,SciRetrieverError
from ..utils.logging import get_logger,setup_logging
from .searcher import BaseSearcher
from pathlib import Path

log_ = Path.cwd() / 'logs' / 'sciretriever.log'
setup_logging(log_file = log_)
logger = get_logger(__name__)

class CRClient(NetworkClient):
    """
    基于爬虫类通用客户端,编写处理crossref网络请求的客户端
    仅接受条件，自动构建url

    额外参数：
        email: 邮箱
    """
    def __init__(
        self,
        email:str,
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
        self.email = email
        self.base_url = "https://api.crossref.org"
        self.default_headers.update({"mailto ":self.email})
        self.session = self._create_session()
        

    def get_work(self, doi: str) -> Paper:
        """
        获取单篇论文完整元数据
        参数：
            doi: 标准DOI标识符（如"10.1038/nature12345"）
        返回：
            Paper对象（来自models.paper）
        异常：
            SearchError: DOI不存在或请求失败
        """
        endpoint = f"/works/{doi}"
        
        try:
            response = self.get(self.base_url+endpoint)
            if response.status_code == 404:
                raise SearchError(f"DOI {doi} 不存在")
            response.raise_for_status()
            return self._parse_work(response.json()['message'])
            
        except Exception as e:
            self._handle_api_error(e)


    def get_works(
        self,
        query_params: dict[str, str]|None = None,
        filters: dict[str, str|list[str]]|None = None,
        sort: dict[str, str]|None = None,
        max_results: int = 1000,
        cursor: str|None = None
    ) -> Generator[list[Paper], None, None]:
        """
        通用 Works 请求函数
        
        参数:
        query_params: 查询参数字典，支持以下形式：
            - 自由搜索: {'query': '关键词'}
            - 字段级搜索: {'title': '纳米材料', 'author': 'Smith'}
            - 混合模式: {'query': 'combustion', 'abstract': '爆炸'}
        filters: 过滤条件字典，支持多值：
            - {'type': 'journal-article', 'from-pub-date': '2020'}
            - {'license': ['cc-by', 'cc-by-nc']}
        sort: 排序规则 {'field': 'published', 'order': 'desc'}
        max_results: 最大获取数量
        cursor: 分页游标

        返回:
        生成器，每次产出最多 1000 篇论文的列表
        """
        # 参数规范化
        params = self._build_params(
            query_params=query_params,
            filters=filters,
            sort=sort,
            max_results=max_results,
            cursor=cursor
        )

        total = 0
        while total < max_results:
            # 发送请求
            response = self.get(self.base_url+"/works", params=params)
            data = response.json()['message']
            
            # 解析结果
            papers = [self._parse_work(item) for item in data.get('items', [])]
            yield papers
            
            # 更新分页状态
            total += len(papers)
            if len(papers) < params.get('rows', 1000) or not data.get('next-cursor'):
                break
                
            params.update({
                'cursor': data['next-cursor'],
                'rows': min(params['rows'], max_results - total)
            })

    def _build_params(
        self,
        query_params: dict[str,str]|None = None,
        filters: dict[str,Any]|None = None,
        sort: dict[str,Any]|None = None,
        max_results: int = 1000,
        cursor: str|None = None
    ) -> dict[str,Any]:
        """构建请求参数字典"""
        params = {
            'rows': min(1000, max_results),
            'cursor': cursor or "*"
        }

        # 处理查询参数
        if query_params:
            # query_type = 'query' if 'query' in query_params else 'field'
            for field, value in query_params.items():
                if field.startswith('query'):
                    params[field] = value
                else:
                    # 自动转换为字段级查询
                    params[f'query.{field}'] = f'"{value}"' if ' ' in value else value

        # 处理过滤器
        if filters:
            filter_parts = []
            for key, vals in filters.items():
                if isinstance(vals, list):
                    filter_parts.append(f"{key}:{'|'.join(vals)}")
                else:
                    filter_parts.append(f"{key}:{vals}")
            params['filter'] = ",".join(filter_parts)

        # 处理排序
        if sort:
            params['sort'] = sort['field']
            params['order'] = sort.get('order', 'asc')

        return params
    
    def _parse_work(self, work_data: dict[str, Any]) -> Paper:
        """将Crossref的work数据转换为Paper对象"""
        return Paper(
            title=' '.join(work_data.get('title', [''])),
            authors=[f"{a.get('given', '')} {a.get('family', '')}".strip() 
                    for a in work_data.get('author', [])],
            abstract=work_data.get('abstract', ''),
            pub_date=self._parse_date(work_data.get('issued', {})),
            journal=work_data.get('container-title', [''])[0],
            doi=work_data.get('DOI'),
            url=work_data.get('URL'),
            citations=work_data.get('is-referenced-by-count', 0),
            # 可扩展更多字段...
        )

    def _parse_date(self, date_data: dict[str,Any]) -> str|None:
        """解析Crossref日期格式（如"date-parts": [[2020, 5, 15]]）"""
        parts = date_data.get('date-parts', [[]])[0]
        return "-".join(map(str, parts)) if parts else None

    def _parse_filters(self, filters: dict[str,Any]) -> dict[str,Any]:
        """将过滤器字典转换为Crossref的filter参数"""
        if not filters:
            return {}
        return {"filter": ",".join(f"{k}:{v}" for k, v in filters.items())}

    def _handle_api_error(self, error: Exception) -> None:
        """统一处理API错误"""
        if isinstance(error, requests.HTTPError):
            if error.response.status_code == 429:
                raise RateLimitError("触发速率限制，请降低请求频率") from error
            elif 400 <= error.response.status_code < 500:
                raise SearchError(f"请求错误：{error.response.text}") from error
        raise SciRetrieverError(f"Crossref API请求失败：{str(error)}") from error