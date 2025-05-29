
from pathlib import Path
from SciRetriever.database.optera import Insert
from SciRetriever.searcher.google_scholar import GSWorkplace

export_path = Path("/workplace/duanjw/project/google/energetic_material")
insert = Insert.connect_db(
    db_dir='/workplace/duanjw/project/SciRetriever/paper.db',
    create_db=True
    )
totle_GS = GSWorkplace.from_root_dir(root_dir=export_path)
totle_GS.Insert_database(insert)
