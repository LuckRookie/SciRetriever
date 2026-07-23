from ..database.optera import Insert
from ..model.paper import PaperMetadata

from ..utils.logging import get_logger
logger = get_logger(__name__)

def insert_paper_to_db(
    db_dir: str,
    papermetadata: list[PaperMetadata] | PaperMetadata,
    create_db: bool = False,
):
    
    insert = Insert.connect_db(
        db_dir=db_dir,
        create_db=create_db
    )
    logger.info(f"Inserting paper to {db_dir}")
    
    if isinstance(papermetadata, PaperMetadata):
        papers = [papermetadata]
    else:
        papers = papermetadata
    logger.info(f"Inserting {len(papers)} papers")
    
    papers = [paper.export_paper() for paper in papers]
    insert.from_paper_list(papers)
    
    logger.info(f"Insert done")
    
