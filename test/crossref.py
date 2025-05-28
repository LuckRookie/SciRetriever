import requests
import time

BASE_URL = "https://api.crossref.org/works"
params = {
    "query": "energetic materials",
    "rows": 1000,
    "mailto": "1017379159@qq.com",
    "cursor": "*"
}

total_results = 0
while True:
    response = requests.get(BASE_URL, params=params)
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