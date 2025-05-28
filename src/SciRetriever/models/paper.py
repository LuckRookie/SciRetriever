"""
文章元信息
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

@dataclass
class Paper:
    """Represents a scientific paper."""
    
    # Required fields
    title: str
    authors: list[str]
    
    # Optional metadata
    abstract: str|None = None   
    doi: str|None = None
    url: str|None = None
    publisher: str|None = None
    year: int|None = None
    journal: str|None = None
    volume: str|None = None
    issue: str|None = None
    pages: str|None = None
    keywords: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    # PDF information
    downloaded: bool = False
    pdf_path: str|Path|None = None
    download_data: str|None = None
    pdf_url: str|None = None
    
    # Additional data
    references: list["Paper"] = field(default_factory=list)
    citations: list["Paper"] = field(default_factory=list)
    citations_num: int|None = None
    notes: str|None = None
    
    def __post_init__(self):
        """Normalize fields after initialization."""
        # Convert pdf_path to Path if it's a string
        if isinstance(self.pdf_path, str):
            self.pdf_path = Path(self.pdf_path)
            
        # Ensure year is an integer if provided
        if self.year is not None and not isinstance(self.year, int):
            try:
                self.year = int(self.year)
            except (ValueError, TypeError):
                self.year = None
    
    @property
    def full_citation(self) -> str:
        """
        Generate a full citation for the paper.
        
        Returns:
            Formatted citation string
        """
        citation = f"{', '.join(self.authors)}. "
        
        if self.year:
            citation += f"({self.year}). "
            
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
    
    def to_dict(self) -> dict[str, Any]:
        """
        Convert the paper to a dictionary.
        
        Returns:
            Dictionary representation of the paper
        """
        return {
            "title": self.title,
            "authors": self.authors,
            "abstract": self.abstract,
            "doi": self.doi,
            "url": self.url,
            "publisher": self.publisher,
            "year": self.year,
            "journal": self.journal,
            "volume": self.volume,
            "issue": self.issue,
            "pages": self.pages,
            "keywords": self.keywords,
            "downloaded": self.downloaded,
            "pdf_path": str(self.pdf_path) if self.pdf_path else None,
            "download_data": self.download_data.isoformat() if self.download_data else None,
            "notes": self.notes
        }
    
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Paper":
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
    
    def add_keywords(self, keywords: list[str]) -> None:
        if keywords not in self.keywords:
            self.keywords.extend(keywords)
            
    def update_keywords(self, keywords: list[str]) -> None:
        self.keywords = keywords
        
    def update_note(self, note: str) -> None:
        self.notes = note

class Book():
    pass