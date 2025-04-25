# %%
from scholarly import scholarly
from scholarly import ProxyGenerator  # 需要导入ProxyGenerator

# 创建代理生成器
pg1 = ProxyGenerator()
pg2 = ProxyGenerator()
# 设置代理
# 注意这里最新版的httpx库将'proxies'字段移除了，导致目前还没有适配httpx的库出现错误，使用pip install httpx==0.27.2即可
success1 = pg1.SingleProxy(http='http://127.0.0.1:7890')
success2 = pg2.SingleProxy(http='http://127.0.0.1:7890')
# 将代理生成器传递给scholarly
scholarly.use_proxy(pg1,pg2)

# 设置请求超时时间（可选）
scholarly.set_timeout(5)  # 5秒超时

# 进行搜索
result = scholarly.search_pubs('energetic materials')

# 处理搜索结果
for i, pub in enumerate(result):
    print(f"结果 {i+1}:")
    print(f"标题: {pub.get('bib', {}).get('title', '未知')}")
    print(f"作者: {pub.get('bib', {}).get('author', ['未知'])}")
    print(f"年份: {pub.get('bib', {}).get('pub_year', '未知')}")
    print(f"引用数: {pub.get('num_citations', 0)}")
    print("-" * 30)
    # filled = result.pub_parser.fill(pub)
    


#%%
from SciRetriever import NetworkClient
clint = NetworkClient(use_proxy = True)
result = clint.get("http://www.baidu.com")
print(result.text)
# %%
