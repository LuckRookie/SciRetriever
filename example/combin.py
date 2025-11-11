from SciRetriever.database.optera import Query, Insert
from SciRetriever.model.paper import PaperMetadata

"""
过滤出版社名称并合并数据库
"""
PUBLISHER = [
    "Elsevier",
    "Wiley",
    "Springer",
    "Taylor & Francis",
    "American Chemical Society",
    "American Institute of Physics",
    "IOP Publishing",
    "National Institute of Standards and Technology",
    "American Physical Society",
    "Institute of Physics Publishing",
]
TRANS_DICT = {
    "Elsevier BV": "Elsevier",
    "American Chemical Society (ACS)": "American Chemical Society",
    "ACS Publications": "American Chemical Society",
    "pubs.rsc.org": "Royal Society of Chemistry",
    "AIP Publishing": "American Institute of Physics",
    "Wiley Online Library": "Wiley",
    "Springer Science and Business Media LLC": "Springer",
}

dir1 = "1.db"
dir2 = "2.db"
dir3 = "3.db"
dir4 = "4.db"

output = "all.db"

query1 = Query.connect_db(dir1)
query2 = Query.connect_db(dir2)
query3 = Query.connect_db(dir3)
query4 = Query.connect_db(dir4)
query_all = Query.connect_db(output,create_db=True)
insert_all = Insert.connect_db(output)

paper1 = query1.query_all(limit=None)
paper2 = query2.query_all(limit=None)
paper3 = query3.query_all(limit=None)
paper4 = query4.query_all(limit=None)

paper_all = paper1 + paper2 + paper3 + paper4

all_meta = [PaperMetadata.from_paper(paper) for paper in paper_all]
for meta in all_meta:
    if meta.publisher in TRANS_DICT:
        meta.publisher = TRANS_DICT[meta.publisher]
    meta.Insert_database(insert_all)
    
print(all_meta[0])

