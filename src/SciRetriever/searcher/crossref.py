
from typing import Any


import requests
from ..model.paper import PaperMetadata
from ..network import NetworkClient, Proxy
from ..utils.exceptions import SearchError, RateLimitError,SciRetrieverError
from ..utils.logging import get_logger,setup_logging
from .searcher import BaseSearcher
from pathlib import Path

# log_ = Path.cwd() / 'logs' / 'sciretriever.log'
# setup_logging(log_file = log_)
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
        # self.default_headers.update({"mailto":self.email})
        self.update_headers({"mailto":self.email})
        

    def get_works(
        self,
        query_params: dict[str, str]|None = None,
        filters: dict[str, Any]|None = None,
        sort: dict[str, str]|None = None,
        max_results: int = 1000,
        cursor: str|None = None
    ) -> "Crossref":
        """
        通用 Works 请求函数
        
        参数:
        query_params: 查询参数字典，支持以下形式：
            - 自由搜索: {'query': '关键词'}
            - 字段级搜索: {'title': '纳米材料', 'author': 'Smith'}
            - 混合模式: {'query': 'combustion', 'abstract': '爆炸'}
        filters: 过滤条件字典，支持多值：
            - {'type': 'journal-article', 'from-pub-date': '2020-01-01',"until-pub-date:'2025-12-31'"}
            - {'license': ['cc-by', 'cc-by-nc']}
        sort: 排序规则 {'field': 'published', 'order': 'desc'}
        max_results: 单次获取数量
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
        response = self.get(url = self.base_url+"/works", params=params)
        crossref = Crossref.from_works(response=response,params=params,session=self)
        return crossref

    def get_works_by_doi(self,doi:str)->"Crossref":
        """
        根据DOI获取论文信息
        """
        response = self.get(url = self.base_url+f"/works?{doi}")
        crossref = Crossref.from_works(response=response,params={'doi':doi},session=self)
        return crossref
    
    def get_works_by_title(self,title:str)->"Crossref":
        """
        根据DOI获取论文信息
        """
        query = {
            "query.title":title
        }
        params = self._build_params(
            query_params=query,
            filters=None,
            sort=None,
            max_results=1,
            cursor=None
        )
        
        response = self.get(url = self.base_url+"/works",params=params)
        crossref = Crossref.from_works(response=response,params=params,session=self)
        return crossref
    
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
    
    def _handle_api_error(self, error: Exception) -> None:
        """统一处理API错误"""
        if isinstance(error, requests.HTTPError):
            if error.response.status_code == 429:
                raise RateLimitError("触发速率限制，请降低请求频率") from error
            elif 400 <= error.response.status_code < 500:
                raise SearchError(f"请求错误：{error.response.text}") from error
        raise SciRetrieverError(f"Crossref API请求失败：{str(error)}") from error
    
class Crossref():
    def __init__(
        self,
        session:CRClient,
        params:dict[str,str],
        base_url:str,
        next_cursor:str|None=None,
        total_results:int|None=None,
        method:str|None=None,
        items:list[dict[str,Any]]|None=None,
        
        ):
        self.session = session
        self.params = params
        self.base_url = base_url
        self.next_cursor = next_cursor
        self.total_results = total_results
        self.method = method
        self.items = items
        
        logger.info(f"Crossref total_results:{self.total_results}")
    def __len__(self):
        if self.items is None:
            return 0
        return len(self.items)
    def __iter__(self):
        return self
    def __next__(self):
        if self.next_cursor:
            self.params.update({"cursor":self.next_cursor})
            next_response = self.session.get(self.base_url,params=self.params)
            return self.from_works(next_response,self.params,self.session)
        
    @classmethod
    def from_works(cls,response: requests.Response,params:dict[str,str],session:CRClient):
        
        data = response.json()['message']
        items = data.get('items', [])
        total_results = data.get('total-results')
        next_cursor = data.get('next-cursor')
        return cls(
            session=session,
            params = params,
            base_url = response.url.split("?")[0],
            next_cursor=next_cursor,
            total_results=total_results,
            items = items,
            method="works",
        )
    def items2papers(self,item) -> PaperMetadata:
        title = item.get("title",[None])[0]
        authors = self.get_authors(item.get("author",[]))
        abstract = item.get("abstract")
        doi = item.get("DOI")
        url = item.get("URL")
        publisher = item.get("publisher")
        pub_year = self.get_year(item)
        journal = item.get("container-title",[None])[0]
        volume = item.get("volume")
        issue = item.get("issue")
        pages = item.get("page")
        keywords = None
        paper_metadata = item
        type = item.get("type")
        source = item.get("source")
        
        pdf_downloaded = False
        pdf_path = None
        download_data = None
        pdf_url = None
        citations_num = item.get("is-referenced-by-count",0)
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
    def get_year(self,item:dict[str,Any])->int|None:
        """
        获取年份
        """
        if item.get("issued") and item.get("issued").get("date-parts")[0][0]:
            return int(item.get("issued").get("date-parts")[0][0])
        elif item.get("published") and item.get("published").get("date-parts")[0][0]:
            return int(item.get("published").get("date-parts")[0][0])
        else:
            return None
    def export_papers(self)->list[PaperMetadata]:
        """
        导出论文列表
        """
        papers:list[PaperMetadata] = [self.items2papers(paper) for paper in self.items] if self.items else []
        return papers
        
    def get_authors(self,crossref_author):
        author_names:list[str] = []
        for idx, author in enumerate(crossref_author):
            try:
                # 处理字段缺失情况（例如某些作者可能没有affiliation字段）
                given_name = author.get("given", '')
                family_name = author.get("family", '')
                
                # 处理多部分姓名（例如包含中间名）
                full_name_parts = []
                if isinstance(given_name, dict):  # 处理嵌套结构（如{'literal': 'Jean Marie'})
                    full_name_parts.extend(given_name.values())
                else:
                    full_name_parts.append(str(given_name))
                
                if isinstance(family_name, dict):  # 处理嵌套结构
                    full_name_parts.extend(family_name.values())
                else:
                    full_name_parts.append(str(family_name))
                
                # 拼接全名（可自定义分隔符）
                full_name = ' '.join(full_name_parts).strip()
                
                # 过滤空名字（防御性处理）
                if full_name:
                    author_names.append(full_name)
                else:
                    logger.warning(f"{crossref_author} 的作者姓名为空，已跳过")

            except Exception as e:
                print(f"处理作者 {idx} 时发生错误: {str(e)}")
                print(f"原始数据: {author}")
        return author_names