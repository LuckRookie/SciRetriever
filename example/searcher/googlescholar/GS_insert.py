from pathlib import Path
from SciRetriever.searcher.filter import filter_title
from SciRetriever.searcher.google_scholar import GSWorkplace
from SciRetriever.workflow.insert_database import insert_paper_to_db

words = ["catalytic","catalytic material","catalytic component","catalytic crystal","catalytic molecule"]

year_list = [2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,
             2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,
             2022,2023,2024,2025]
root_dir = Path("/home/xxx")

for year in year_list:
    print("**********************************************************************")
    print("start:",year)
    export_path = root_dir / str(year)
    totle_GS = GSWorkplace.from_root_dir(root_dir=export_path)
    paperss = totle_GS.papers.copy()
    # filter
    papers = [paper for list_paper in paperss for paper in list_paper if paper.type=="article" and filter_title(words,paper.title)]
    
    print("papers:",len(papers))
    
    insert_paper_to_db(
        db_dir='/home/xxx/GS.db',
        papermetadata=papers,
        create_db=True
    )
    print("end:",year)
    print("**********************************************************************")


