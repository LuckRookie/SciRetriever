from typing import Any
from sqlalchemy import  Column, Integer, String ,ForeignKey, Boolean,DateTime, Table
from sqlalchemy.orm import backref, mapped_column, Mapped,relationship,DeclarativeBase
from sqlalchemy.dialects.sqlite import JSON
import datetime

class Base(DeclarativeBase):
    pass

# 中间表（关联表）
paper_citation_association = Table(
    'paper_citation_association',
    Base.metadata,
    Column(
        'citing_paper_id', 
        Integer, 
        ForeignKey('papers.id', ondelete='CASCADE'),  # 级联删除引用者
        primary_key=True
    ),
    Column(
        'cited_paper_id', 
        Integer, 
        ForeignKey('papers.id', ondelete='CASCADE'),  # 级联删除被引者
        primary_key=True
    )
)

class Paper(Base):
    __tablename__:str = 'papers'
    
    # 主键ID,用于唯一标识每条记录
    id:Mapped[int] = mapped_column(Integer, primary_key=True)
    title:Mapped[str] = mapped_column(String, nullable=True)
    authors:Mapped[list[str]] = mapped_column(JSON, nullable=True)
    abstract:Mapped[str] = mapped_column(String, nullable=True)
    doi:Mapped[str] = mapped_column(String, nullable=True)
    url:Mapped[str] = mapped_column(String, nullable=True)
    publisher:Mapped[str] = mapped_column(String, nullable=True)
    pub_year:Mapped[int] = mapped_column(Integer, nullable=True)
    journal:Mapped[str] = mapped_column(String, nullable=True)
    volume:Mapped[str] = mapped_column(String, nullable=True)
    issue:Mapped[str] = mapped_column(String, nullable=True)
    pages:Mapped[str] = mapped_column(String, nullable=True)
    keywords:Mapped[list[str]] = mapped_column(JSON, nullable=True)
    paper_metadata:Mapped[dict[str,Any]] = mapped_column(JSON, nullable=True)
    created_at:Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.now, nullable=False)
    pdf_downloaded:Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    pdf_path:Mapped[str] = mapped_column(String, nullable=True)
    pdf_url:Mapped[str] = mapped_column(String, nullable=True)
    citations_num:Mapped[int] = mapped_column(Integer, nullable=True)
    notes:Mapped[str] = mapped_column(String, nullable=True)
    type:Mapped[str] = mapped_column(String, nullable=True) # article or book
    source:Mapped[str] = mapped_column(String, nullable=True) # GS or Crossref or other
    cited_papers = relationship(
        'Paper',  # 关联到自身
        secondary=paper_citation_association,
        primaryjoin=lambda: Paper.id == paper_citation_association.c.citing_paper_id,  # 主动引用的条件
        secondaryjoin=lambda: Paper.id == paper_citation_association.c.cited_paper_id,  # 被引用的条件
        backref=backref('cited_by', lazy='dynamic'),  # 反向引用关系
        lazy='dynamic',  # 延迟加载
        passive_deletes=True  # 关键配置
    )

    def __repr__(self):
        return f"<Paper(id={self.id}, title='{self.title}')>"
    
    def dump_dict(self) -> dict[str,Any]:
        """将 Paper 对象的基础字段转换为字典"""
        
        return {
            "id": self.id,
            "title": self.title,
            "authors": self.authors,
            "abstract": self.abstract,
            "doi": self.doi,
            "url": self.url,
            "publisher": self.publisher,
            "pub_year": self.pub_year,
            "journal": self.journal,
            "volume": self.volume,
            "issue": self.issue,
            "pages": self.pages,
            "keywords": self.keywords,
            "type": self.type,
            "source": self.source,
            "paper_metadata": self.paper_metadata,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "pdf_downloaded": self.pdf_downloaded,
            "pdf_path": self.pdf_path,
            "pdf_url": self.pdf_url,
            "citations_num": self.citations_num,
            "notes": self.notes
        }
        
# class Author(Base):
#     __tablename__:str = 'Author_table'

#     # 主键ID,用于唯一标识每条记录