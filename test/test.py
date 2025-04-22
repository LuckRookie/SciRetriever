#%% requerts
import requests

proxies = {
    'http': 'http://127.0.0.1:7890',
    'https': 'http://127.0.0.1:7890'
}

try:
    response = requests.get('https://scholar.google.com', proxies=proxies, timeout=10)
    print(f"连接状态: {response.status_code}")
except Exception as e:
    print(f"连接失败: {e}")
    
#%% httpx
import httpx

proxies = {
    'http://': 'http://127.0.0.1:7890',
    'https://': 'http://127.0.0.1:7890'
}

try:
    with httpx.Client(proxies=proxies, timeout=10.0) as client:
        response = client.get('https://scholar.google.com')
        print(f"连接状态: {response.status_code}")
except Exception as e:
    print(f"连接失败: {e}")
# %%
