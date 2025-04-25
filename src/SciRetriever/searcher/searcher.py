"""
Base searcher class for SciRetriever.
This module provides an abstract base class for different search engine implementations.
"""

import abc
from typing import Dict, List, Optional, Union, Any

from ..models.paper import Paper
from ..network import NetworkClient
from ..utils.exceptions import SearchError
from ..utils.logging import get_logger

logger = get_logger(__name__)


class BaseSearcher(abc.ABC):
    """Abstract base class for search engine implementations."""
    
    def __init__(
        self,
        client: NetworkClient = NetworkClient(),
        ):
        """
        Initialize the searcher.
        """
        self.client = client
        
    
    
    @abc.abstractmethod
    def search(
        self, 
        query: str, 
        limit: int = 10, 
        **kwargs
    ) -> List[Paper]:
        """
        Search for papers matching the given query.
        
        Args:
            query: The search query
            limit: Maximum number of results to return
            **kwargs: Additional search parameters specific to the engine
            
        Returns:
            A list of Paper objects
            
        Raises:
            SearchError: If the search fails
        """
        pass
    
    # @abc.abstractmethod
    # def get_paper_by_doi(self, doi: str) -> Optional[Paper]:
    #     """
    #     Retrieve a specific paper by its DOI.
        
    #     Args:
    #         doi: The DOI of the paper
            
    #     Returns:
    #         A Paper object or None if not found
            
    #     Raises:
    #         SearchError: If the retrieval fails
    #     """
    #     pass

    # @abc.abstractmethod
    # def get_citations(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
    #     """
    #     Get papers that cite the given paper.
        
    #     Args:
    #         paper: A Paper object or DOI string
    #         limit: Maximum number of results to return
            
    #     Returns:
    #         A list of Paper objects
            
    #     Raises:
    #         SearchError: If the retrieval fails
    #     """
    #     pass
    
    # @abc.abstractmethod
    # def get_references(self, paper: Union[Paper, str], limit: int = 10) -> List[Paper]:
    #     """
    #     Get papers cited by the given paper.
        
    #     Args:
    #         paper: A Paper object or DOI string
    #         limit: Maximum number of results to return
            
    #     Returns:
    #         A list of Paper objects
            
    #     Raises:
    #         SearchError: If the retrieval fails
    #     """
    #     pass