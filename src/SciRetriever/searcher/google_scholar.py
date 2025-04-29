"""
Google Scholar searcher implementation.
"""

import time
from typing import Dict, List, Optional, Union, Any

from scholarly import scholarly,ProxyGenerator
from bs4 import BeautifulSoup
from requests import Response
import re
from ..models.paper import Paper
from ..network import NetworkClient
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
_BIBCITE = '/scholar?hl=en&q=info:{0}:scholar.google.com/\
&output=cite&scirp={1}&hl=en'
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
        Search for papers using Google Scholar.
        
        Args:
            query: The search query
            limit: Maximum number of results to return
            fields: Not used for Google Scholar
            **kwargs: Additional parameters:
                year_start: Start year for filtering
                year_end: End year for filtering
                
        Returns:
            A list of Paper objects
            
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
        
class GoogleScholar():
    """
    Google Scholar的页面对象
    """
    def __init__(
        self,
        response: Response,
        session: NetworkClient,
        ) -> None:
        if not response:
            raise "ERROR: 请提供response"
        
        self.soup = BeautifulSoup(response.text, "html.parser")
        self.url = response.url
        self.rows = self.soup.find_all('div', class_='gs_r gs_or gs_scl') + self.soup.find_all('div', class_='gsc_mpat_ttl')
        # 删除一些没有data-cid的文章或者广告
        self.rows = [row for row in self.rows if row.get("data-cid")]
        self.next = self.soup.find(class_='gs_ico gs_ico_nav_next')
        self.totle_results = self._get_total_results()
        self.session = session
        
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
        if self.next:
            next_url = self.next.get("href")
            response = self.session.get(next_url)
            return GoogleScholar(response, self.session)
        else:
            raise StopIteration
    
    def __iter__(self):
        return self
    def get_rows(self):
        
        pass
        
class GSRow():
    """
    GoogleScholar中一个文章的对象
    """
    def __init__(
        self,
        row: BeautifulSoup,
        pos: int,
        ) -> None:
        self.row = row
        self.pos = pos
        self.load_information()
        self.filled = False
    
    def load_information(self):
        """根据row加载信息"""
        row = self.row
        databox = row.find('div', class_='gs_ri')
        self.title = databox.find('h3', class_='gs_rt')
        if self.title.find('a'):
            self.pub_url = self.title.find('a')['href']
        self.cid = row.get('data-cid')
        self.pos = row.get('data-rp')
        
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
        pass
    
    def load_fill(self):
        self.filled = True
        
        pass
    
class GoogleScholarParser():
    """
    给一个GoogleScholar返回的页面，解析出论文信息
    """
    def __init__(
        self,
        
        ) -> None:
        pass
    pass