
from SciRetriever.searcher.crossref import CRClient,Crossref
from SciRetriever.network import Proxy
from SciRetriever.database.optera import Insert
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
    "title": "Testing and evaluation of the thermal damage caused by an explosion of energetic materials",
    
}

result = Client.get_works(
    query_params=query,
    )
# insert = Insert.connect_db(
#     db_dir='/workplace/duanjw/project/SciRetriever/crossref.db',
#     create_db=True
#     )
# while True:
#     if result is None:
#         break
#     paper_list = result.export_papers()
#     for paper in paper_list:
#         paper.Insert_database(insert)

#     result = next(result)
    
    
# print(result)
