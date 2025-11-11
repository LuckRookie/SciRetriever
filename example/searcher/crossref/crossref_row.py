import requests
import time
BASE_URL = "https://api.crossref.org/works"
params = {
    "query": "energetic materials",
    "rows": 1000,
    "mailto": "xxxx@xxxx.com",
    "cursor": "*"
}
sesssion = requests.Session()
sesssion.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "mailto": "1017379159@qq.com",
})
total_results = 0
while True:
    response = sesssion.get(BASE_URL, params=params)
    if response.status_code != 200:
        print(f"Error: {response.status_code}")
        break
    
    data = response.json()
    works = data["message"]["items"]
    total_results += len(works)
    
    # 处理当前页数据（例如保存到文件）
    for work in works:
        print(f"DOI: {work.get('DOI')}, Title: {work.get('title')[0]}")
    
    # 检查是否还有下一页
    next_cursor = data["message"]["next-cursor"]
    if not next_cursor or len(works) < params["rows"]:
        break
    
    # 更新游标，添加延迟以避免速率限制
    params["cursor"] = next_cursor
    time.sleep(0.5)  # 礼貌池建议间隔

print(f"Total results fetched: {total_results}")