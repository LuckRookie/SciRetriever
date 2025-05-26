# %%
from SciRetriever.searcher import GSClient,GoogleScholarSearcher,GSRowError,Total_GoogleScholar
from SciRetriever.network import Proxy
from SciRetriever.searcher.google_scholar import GoogleScholar
from SciRetriever.utils.exceptions import RetryError
from pathlib import Path
def fill_result(result:GoogleScholar):
    try:
        page.fill_all_bib()
    except IndexError as e:
        fill_result(result)
        
export_path = Path("/workplace/duanjw/project/google/energetic_material")
        
client = GSClient(
    mirror=1,
    use_proxy = False,
    proxy = Proxy(http="127.0.0.1:7890",https='127.0.0.1:7890'),
    max_retries = 5,
    verify=True,
    )
#%%

searcher = GoogleScholarSearcher(client=client)
# 本次查询的第一个页面

try:
    results = searcher.search_publication(query = 'energetic materials')
    
except RetryError as e:
    print("All retries failed")
    raise
    
except GSRowError as e:
    """再来一次"""
    print("page error")
    results = searcher.search_publication(query = 'energetic materials')

totle_GS = Total_GoogleScholar(start_page=results)

for num,page in enumerate(totle_GS):
    #fill_result(page)
    #page.export_json(export_path / f"page_{num}.json")
    print(f"page {num} done")
#%%

# result = GoogleScholar.from_json(
#     json_path="/workplace/duanjw/project/SciRetriever/page1.json",
#     session=client
#     )
# result.fill_all_bib()

