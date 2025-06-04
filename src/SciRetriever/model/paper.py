"""
文章元信息
"""
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ..utils.logging import get_logger
from ..database.optera import Insert
from ..database.model import Paper

logger = get_logger(__name__)
@dataclass
class PaperMetadata():
    """Represents a scientific paper."""
    
    # Required fields
    title: str
    authors: list[str]
    
    # Optional metadata
    abstract: str|None = None   
    doi: str|None = None
    url: str|None = None
    publisher: str|None = None
    pub_year: int|None = None
    journal: str|None = None
    volume: str|None = None
    issue: str|None = None
    pages: str|None = None
    keywords: list[str]|None = field(default_factory=list)
    paper_metadata: dict[str, Any]|None = field(default_factory=dict)
    type: str|None = None
    # PDF information
    pdf_downloaded: bool = False
    pdf_path: str|Path|None = None
    download_data: str|None = None
    pdf_url: str|None = None
    
    # Additional data
    references: list["PaperMetadata"] = field(default_factory=list)
    citations: list["PaperMetadata"] = field(default_factory=list)
    citations_num: int|None = None
    notes: str|None = None
    
    def __post_init__(self):
        """Normalize fields after initialization."""
        # Convert pdf_path to Path if it's a string
        if isinstance(self.pdf_path, str):
            self.pdf_path = Path(self.pdf_path)
            
        # Ensure year is an integer if provided
        if self.pub_year is not None and not isinstance(self.pub_year, int):
            try:
                self.pub_year = int(self.pub_year)
            except (ValueError, TypeError):
                self.pub_year = None
                
    def Insert_database(self,insert:Insert) -> None:
        """将全部插入到数据库中"""
        paper_dict = self.__dict__.copy()
        paper_dict.pop("references")
        paper_dict.pop("citations")
        
        paper = Paper(**paper_dict)
        insert.from_paper(paper)
        logger.info(f"paper_{self.title}插入完成")
        
    @property
    def full_citation(self) -> str:
        """
        Generate a full citation for the paper.
        
        Returns:
            Formatted citation string
        """
        citation = f"{', '.join(self.authors)}. "
        
        if self.pub_year:
            citation += f"({self.pub_year}). "
            
        citation += f"{self.title}. "
        
        if self.journal:
            citation += f"{self.journal}"
            
            if self.volume:
                citation += f", {self.volume}"
                
                if self.issue:
                    citation += f"({self.issue})"
                    
            if self.pages:
                citation += f", {self.pages}"
                
            citation += "."
            
        if self.doi:
            citation += f" DOI: {self.doi}"
            
        return citation
    
    # def to_dict(self) -> dict[str, Any]:
    #     """
    #     Convert the paper to a dictionary.
        
    #     Returns:
    #         Dictionary representation of the paper
    #     """
    #     return {
    #         "title": self.title,
    #         "authors": self.authors,
    #         "abstract": self.abstract,
    #         "doi": self.doi,
    #         "url": self.url,
    #         "publisher": self.publisher,
    #         "pub_year": self.pub_year,
    #         "journal": self.journal,
    #         "volume": self.volume,
    #         "issue": self.issue,
    #         "pages": self.pages,
    #         "keywords": self.keywords,
    #         "pdf_downloaded": self.pdf_downloaded,
    #         "pdf_path": str(self.pdf_path) if self.pdf_path else None,
    #         "notes": self.notes
    #     }
    
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaperMetadata":
        """
        Create a Paper instance from a dictionary.
        
        Args:
            data: Dictionary representation of a paper
            
        Returns:
            Paper instance
        """
        # Handle download_date if it's a string
        if "download_date" in data and isinstance(data["download_date"], str):
            try:
                data["download_date"] = datetime.fromisoformat(data["download_date"])
            except ValueError:
                data["download_date"] = None
        
        return cls(**data)
    
    # def add_keywords(self, keywords: list[str]) -> None:
    #     if keywords not in self.keywords:
    #         self.keywords.extend(keywords)
            
    def update_keywords(self, keywords: list[str]) -> None:
        self.keywords = keywords
        
    def update_note(self, note: str) -> None:
        self.notes = note
