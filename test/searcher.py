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
# 破解aigrogu
import requests
from bs4 import BeautifulSoup
import re
import time

try:
    from fake_useragent import UserAgent
    FAKE_USERAGENT = True
except Exception:
    FAKE_USERAGENT = False
    DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36'


# 设置请求 URL
url = "https://scholar.aigrogu.com/scholar"

# 设置查询参数
params = {
    "hl": "en",
    "q": "energetic materials",
    "as_vis": "0",
    "as_sdt": "0,33"
}


# 必须有请求头
headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
    "sec-ch-ua": "\"Microsoft Edge\";v=\"135\", \"Not-A.Brand\";v=\"8\", \"Chromium\";v=\"135\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1"
}
headers = {
    "user-agent": UserAgent().random,
}
# 创建会话对象以保持Cookie
session = requests.Session()
session.headers.update(headers)

# 第一次请求，获取验证页面
response = session.get(
    url=url,
    params=params
)

# 检查是否是验证页面
if 'AutoJump' in response.text:
    print("检测到验证页面，正在提取验证Cookie...")
    
    # 从页面中提取cookie值
    cookie_match = re.search(r'document\.cookie="google_verify_data=([^;]+);', response.text)
    if cookie_match:
        verify_data = cookie_match.group(1)
        
        # 手动设置cookie
        session.cookies.set('google_verify_data', verify_data, domain='scholar.aigrogu.com', path='/')
        print(f"设置Cookie: google_verify_data={verify_data}")
        
        # 等待一小段时间模拟浏览器行为
        time.sleep(1)
        
        # 再次请求
        response = session.get(
            url=url,
            params=params,
        )
        
        print(f"二次请求状态码: {response.status_code}")
    else:
        print("无法从页面提取验证Cookie")
else:
    print("直接获取到内容页面")

# 处理响应
if response.status_code == 200:
    # 处理响应内容
    html_content = response.text
    # 与 _navigator.py 中类似，替换特殊字符
    html_content = html_content.replace(u'\xa0', u' ')
    
    # 检查是否成功获取到搜索结果
    if "gs_r gs_or gs_scl" in html_content or "gs_ri" in html_content:
        print("成功获取搜索结果页面")
        
        # 使用BeautifulSoup解析结果
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # 查找搜索结果
        results = soup.find_all('div', class_=['gs_r', 'gs_or', 'gs_scl'])
        print(f"找到 {len(results)} 条搜索结果")
        
        # 解析每个结果
        for i, result in enumerate(results[:5]):  # 只显示前5条
            title_tag = result.find('h3', class_='gs_rt')
            title = title_tag.text if title_tag else "未找到标题"
            
            authors_tag = result.find('div', class_='gs_a')
            authors = authors_tag.text if authors_tag else "未找到作者"
            
            snippet_tag = result.find('div', class_='gs_rs')
            snippet = snippet_tag.text if snippet_tag else "未找到摘要"
            
            print(f"\n结果 {i+1}:")
            print(f"标题: {title}")
            print(f"作者信息: {authors}")
            print(f"摘要: {snippet}")
    else:
        print("未能获取到搜索结果，可能仍在验证页面")
        print("页面内容片段:")
        print(html_content[:500])  # 打印页面前500个字符以便调试
else:
    print(f"请求失败，状态码: {response.status_code}")
    print(response.text[:500])  # 只打印部分内容
# %%
