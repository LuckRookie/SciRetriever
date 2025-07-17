# %%
from unittest import result
from SciRetriever.searcher import GSClient,GoogleScholarSearcher,GSPageError,GSWorkplace
from SciRetriever.network import Proxy
from SciRetriever.searcher.google_scholar import GoogleScholar
from SciRetriever.utils.exceptions import RetryError
from pathlib import Path
# def fill_result(result:GoogleScholar):
#     try:
#         result.fill_all_bib()
#     except IndexError as e:
#         fill_result(result)
export_path = Path("/workplace/duanjw/project/google/cyclo-N5")
        
session = GSClient(
    mirror=0,
    use_proxy = True,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    retry_delay=5,
    verify=True,
    )
#%%

searcher = GoogleScholarSearcher(client=session)
# 本次查询的第一个页面

try:
    results = searcher.search_publication(query = 'cyclo-N5',start_index=340)
    
except RetryError as e:
    """再来一次"""
    print("page error")
    results = searcher.search_publication(query = 'cyclo-N5')
    
except GSPageError as e:
    """再来一次"""
    print("page error")
    results = searcher.search_publication(query = 'cyclo-N5')

print(results)
# totle_GS = Total_GoogleScholar(start_page=results,root_dir=export_path)

# for num,page in enumerate(totle_GS):
#     fill_result(page)
#     page.export_json(export_path / f"page_{num}.json")
#     print(f"page {num} done")
#%%

# result = GoogleScholar.from_json(
#     json_path="/workplace/duanjw/project/SciRetriever/page1.json",
#     session=session
#     )
# result.fill_all_bib()

# result = GoogleScholar.from_html(
#     html_path ="/workplace/duanjw/project/SciRetriever/test.html",
#     session=session
#     )
