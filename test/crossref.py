
from SciRetriever.searcher.crossref import CRClient,Crossref
from SciRetriever.network import Proxy
from SciRetriever.database.optera import Insert
from SciRetriever.searcher.filter import filter_title
Client = CRClient(
    email = "1017379159@qq.com",
    use_proxy = False,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay=5,
    verify=True,
)

''' 
query_params: 查询参数字典，支持以下形式：
    - 自由搜索: {'query': '关键词'}
    - 字段级搜索: {'title': '纳米材料', 'author': 'Smith'}
    - 混合模式: {'query': 'combustion', 'abstract': '爆炸'}
'''

query = {
    "query": "energetic materials synthesis",
}
filters = {
    "type":"journal-article",
    "from-pub-date":"2000-01-01",
    "until-pub-date":"2025-12-31"
}
result = Client.get_works(
    query_params=query,
    filters=filters,
    )
insert = Insert.connect_db(
    db_dir='/workplace/duanjw/project/SciRetriever/CR_energetic_materials_synthesis.db',
    create_db=True
    )
while True:
    if result is None:
        break
    paper_list = result.export_papers()
    paper_list = [paper.export_paper() for paper in paper_list 
                  if (paper.doi is not None) and (paper.title is not None) and (paper.type == "journal-article") and filter_title(paper.title)]
    insert.from_paper_list(paper_list)
    
    result = next(result)
    
    
# print(result)
