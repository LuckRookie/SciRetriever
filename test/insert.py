
from pathlib import Path
from SciRetriever.database.optera import Insert
from SciRetriever.searcher.google_scholar import GSWorkplace

export_path = Path("/workplace/duanjw/project/google/energetic_materials/2000")
insert = Insert.connect_db(
    db_dir='/workplace/duanjw/project/SciRetriever/paper2.db',
    create_db=True
    )
totle_GS = GSWorkplace.from_root_dir(root_dir=export_path)
paperss = totle_GS.papers.copy()

# filter
papers = [paper for list_paper in paperss for paper in list_paper if paper.type=="article"]

print(papers)

