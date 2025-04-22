"""
Semantic Scholar searcher implementation.
"""

import logging
from typing import Dict, List, Optional, Union, Any

from semanticscholar import SemanticScholar

from ..models.paper import Paper
from ..utils.config import get_config
from ..utils.exceptions import SearchError
from ..utils.logging import get_logger
from .searcher import BaseSearcher

logger = get_logger(__name__)


class SemanticScholarSearcher(BaseSearcher):
    """Implementation of BaseSearcher for Semantic Scholar."""
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize the Semantic Scholar searcher.
        
        Args:
            api_key: API key for Semantic Scholar (optional)
        """
        # Get API key from config if not provided
        if api_key is None:
            config = get_config()
            api_key = config.get_api_key("semantic_scholar")
        
        super().__init__(api_key)
        
        try:
            self.sch = SemanticScholar(api_key=api_key)
            logger.info("Initialized Semantic Scholar searcher")
        except Exception as e:
            logger.error(f"Error initializing Semantic Scholar API: {e}")
            raise SearchError(f"Failed to initialize Semantic Scholar API: {e}")
    
    def search(
        self, 
        query: str, 
        limit: int = 10, 
        fields: Optional[List[str]] = None, 
        **kwargs
    ) -> List[Paper]:
        """
        Search for papers using Semantic Scholar API.
        
        Args:
            query: The search query
            limit: Maximum number of results to return
            fields: Specific fields to retrieve
            **kwargs: Additional parameters for the Semantic Scholar API
                year_start: Start year for filtering
                year_end: End year for filtering
            
        Returns:
            A list of Paper objects
            
        Raises:
            SearchError: If the search fails
        """
        logger.info(f"Searching Semantic Scholar for: {query}")
        
        # Default fields if none specified
        if fields is None:
            fields = [
                'title', 'authors', 'abstract', 'year', 'venue', 'url', 
                'paperId', 'externalIds', 'fieldsOfStudy'
            ]
        
        # Handle year filtering
        year_start = kwargs.get('year_start')
        year_end = kwargs.get('year_end')
        
        if year_start and year_end:
            logger.info(f"Filtering by year range: {year_start} to {year_end}")
            query = f"{query} year:{year_start}-{year_end}"
        elif year_start:
            logger.info(f"Filtering by start year: {year_start}")
            query = f"{query} year>={year_start}"
        elif year_end:
            logger.info(f"Filtering by end year: {year_end}")
            query = f"{query} year<={year_end}"
        
        try:
            results = self.sch.search_paper(query, limit=limit, fields=fields, **kwargs)
            papers = [self._convert_to_paper(paper) for paper in results]
            logger.info(f"Found {len(papers)} papers on Semantic Scholar")
            return papers
        except Exception as e:
            logger.error(f"Error searching Semantic Scholar: {e}")
            raise SearchError(f"Failed to search Semantic Scholar: {e}")
    
    def get_paper_by_doi(self, doi: str) -> Optional[Paper]:
        """
        Retrieve a specific paper by its DOI.
        
        Args:
            doi: The DOI of the paper
            
        Returns:
            A Paper object or None if not found
            
        Raises:
            SearchError: If the retrieval fails
        """
        logger.info(f"Retrieving paper with DOI: {doi}")
        try:
            paper_data = self.sch.get_paper(f"DOI:{doi}")
            if paper_data:
                return self._convert_to_paper(paper_data)
            logger.info(f"No paper found with DOI: {doi}")
            return None
        except Exception as e:
            logger.error(f"Error retrieving paper by DOI: {e}")
            raise SearchError(f"Failed to retrieve paper with DOI {doi}: {e}")
    
    def get_citations(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
        """
        Get papers that cite the given paper.
        
        Args:
            paper: A Paper object or DOI string
            limit: Maximum number of results to return
            
        Returns:
            A list of Paper objects
            
        Raises:
            SearchError: If the retrieval fails
        """
        paper_id = paper.doi if isinstance(paper, Paper) else paper
        if not paper_id.startswith("DOI:") and ":" not in paper_id:
            paper_id = f"DOI:{paper_id}"
        
        logger.info(f"Retrieving citations for: {paper_id}")
        try:
            citations = self.sch.get_paper_citations(paper_id, limit=limit)
            return [self._convert_to_paper(citation) for citation in citations]
        except Exception as e:
            logger.error(f"Error retrieving citations: {e}")
            raise SearchError(f"Failed to retrieve citations for {paper_id}: {e}")
    
    def get_references(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
        """
        Get papers cited by the given paper.
        
        Args:
            paper: A Paper object or DOI string
            limit: Maximum number of results to return
            
        Returns:
            A list of Paper objects
            
        Raises:
            SearchError: If the retrieval fails
        """
        paper_id = paper.doi if isinstance(paper, Paper) else paper
        if not paper_id.startswith("DOI:") and ":" not in paper_id:
            paper_id = f"DOI:{paper_id}"
        
        logger.info(f"Retrieving references for: {paper_id}")
        try:
            references = self.sch.get_paper_references(paper_id, limit=limit)
            return [self._convert_to_paper(reference) for reference in references]
        except Exception as e:
            logger.error(f"Error retrieving references: {e}")
            raise SearchError(f"Failed to retrieve references for {paper_id}: {e}")
    
    def _convert_to_paper(self, data: Dict[str, Any]) -> Paper:
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