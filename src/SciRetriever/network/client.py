"""
对所有爬虫类网络请求都适用的对象
"""
from http.client import USE_PROXY
import time
from pathlib import Path
from typing import Dict, Optional, Union, Any
import random
import requests

try:
    from fake_useragent import UserAgent
    FAKE_USERAGENT = True
except Exception:
    FAKE_USERAGENT = False
    DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36'

from ..utils.config import get_config
from ..utils.exceptions import DownloadError, RateLimitError
from ..utils.logging import get_logger

logger = get_logger(__name__)


class RateLimiter:
    """限制对服务器请求速率的类"""
    
    def __init__(self, rate_limit: float = None):
        """
        Initialize rate limiter.
        
        Args:
            rate_limit: Minimum seconds between requests, None to use config
        """
        self.config = get_config()
        self.rate_limit = rate_limit or self.config.get("network.rate_limit", 5.0)
        self.last_request_time = 0.0
    
    def wait(self):
        """Wait if necessary to respect rate limit."""
        current_time = time.time()
        elapsed = current_time - self.last_request_time
        
        if elapsed < self.rate_limit:
            sleep_time = self.rate_limit - elapsed
            logger.debug(f"Rate limiting: sleeping for {sleep_time:.2f} seconds")
            time.sleep(sleep_time)
        
        self.last_request_time = time.time()

class Proxy:
    """管理代理设置的类"""
    
    def __init__(self,http:str=None,https:str=None):
        self.http = http
        self.https = https
        self._proxies = {
            'http': self.http,
            'https': self.https
        }
    def get_proxies(self) -> Dict[str, str]:
        return self._proxies
    @classmethod
    def from_config(cls, config: Dict[str, str]) -> 'Proxy':
        return cls(
            http=config.get('proxy.http', None),
            https=config.get('proxy.https', None)
        )

    
class NetworkClient:
    """Client for making network requests with retries and rate limiting."""
    
    def __init__(
        self,
        rate_limit: Optional[RateLimiter] = None,
        max_retries: Optional[int] = None,
        retry_delay: Optional[float] = None,
        timeout: Optional[float] = None,
        user_agent: Optional[str] = None,
        use_proxy: bool = False,
        proxy: Optional[Proxy] = None,
        headers: Optional[Dict[str, str]] = None,
        allow_redirects: bool = True,
        cookie: Optional[Dict[str, str]] = None,
        verify: bool = False
    ):
        """
        初始化网络客户端
        
        Args:
            rate_limit: 请求之间的最小间隔秒数
            max_retries: 请求失败时的最大重试次数
            retry_delay: 重试之间的延迟秒数
            timeout: 请求超时秒数
            user_agent: 请求使用的用户代理字符串
            use_proxy: 是否使用代理设置（如果可用）
            headers: 所有请求的默认HTTP头信息
            allow_redirects: 是否默认跟随重定向
            verify: 是否默认验证SSL证书
        """
        self.config = get_config()
        self.rate_limiter = RateLimiter(rate_limit)
        self.max_retries = max_retries or self.config.get("session.max_retries", 3)
        self.retry_delay = retry_delay or self.config.get("session.retry_delay", 2.0)
        self.timeout = timeout or self.config.get("session.timeout", 30.0)
        self.use_proxy = use_proxy
        self.proxy = proxy or Proxy.from_config(self.config)
        # 设置代理
        if not user_agent:
            user_agent = self._get_user_agent()
        self.user_agent = user_agent
        
        # Set default request settings
        self.default_headers = headers or {}
        if 'User-Agent' not in self.default_headers:
            self.default_headers['User-Agent'] = self.user_agent
            
        # 添加相同的请求头
        if 'accept-language' not in self.default_headers:
            self.default_headers['accept-language'] = 'en-US,en'
        if 'accept' not in self.default_headers:
            self.default_headers['accept'] = 'text/html,application/xhtml+xml,application/xml'
        
        self.allow_redirects = allow_redirects
        self.verify = verify
        self.cookie = cookie
        # 创建session
        self.session = self._create_session()
    
    def _get_version(self) -> str:
        """Get SciRetriever version."""
        try:
            from .. import __version__
            return __version__
        except (ImportError, AttributeError):
            return "0.1.0"
        
    def _get_user_agent(self) -> str:
        """Get a user agent string, either random from fake-useragent or default."""
        if FAKE_USERAGENT:
            # Suppress the misleading traceback from UserAgent()
            # To implement this properly, you would need a context manager to suppress logger
            try:
                user_agent = UserAgent().random
            except Exception:
                user_agent = DEFAULT_USER_AGENT
        else:
            user_agent = DEFAULT_USER_AGENT
            
        return user_agent
        
    def update_cookie(self,cookie:Dict[str,str]) -> None:
        """
        更新session的cookie
        """
        self.session.cookies.update(cookie)

    def update_headers(self,headers:Dict[str,str]) -> None:
        """
        更新session的headers
        """
        self.session.headers.update(headers)

    def _create_session(self) -> requests.Session:
        """创建并配置session"""
        session = requests.Session()
        # 设置默认headers
        session.headers.update(self.default_headers)
        session.verify = self.verify
        session.allow_redirects = self.allow_redirects
        # Note: timeout 无法写在session中.必须每次请求进行指定

        # 应用cookie
        if self.cookie:
            session.cookies.update(self.cookie)

        # 应用代理
        if self.use_proxy:
            proxy_settings = self.proxy.get_proxies()
            if proxy_settings and (proxy_settings.get('http') or proxy_settings.get('https')):
                session.proxies.update(proxy_settings)
                logger.info(f"Applied proxy: {proxy_settings}")
            else:
                logger.warning("No valid proxy settings found. Proxies will not be used.")
        return session
    
    def get(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> requests.Response:
        """
        发送GET请求并返回响应。
        
        参数:
            url: 请求的URL地址
            params: URL查询参数，会被添加到URL的?后面
                例如: {'q': 'python', 'page': 1} 会转换为 '?q=python&page=1'
            **kwargs: 其他可选参数，用于覆盖会话默认设置，常用选项包括:
                    - headers: Dict[str, str] - 请求头信息
                    例如: {'Accept': 'application/json'}
                    - cookies: Dict[str, str] - 请求cookies
                    例如: {'session_id': '123456'}
                    - timeout: float - 请求超时时间(秒)
                    例如: 30.0
                    - allow_redirects: bool - 是否允许重定向
                    例如: True
                    - verify: bool - 是否验证SSL证书
                    例如: False
                    - stream: bool - 是否以流式方式处理响应
                    例如: True
                    - cert: str - 客户端证书路径
                    例如: '/path/to/client.pem'
                    - proxies: Dict[str, str] - 代理设置
                    例如: {'http': 'http://10.10.1.10:3128'}
                    - auth: Tuple[str, str] - 基本认证信息(用户名,密码)
                    例如: ('user', 'pass')
        
        返回:
            requests.Response对象，包含服务器响应的完整信息
        
        异常:
            DownloadError: 当请求在多次重试后仍然失败时抛出
        
        使用示例:
            # 基本GET请求
            response = client.get('https://api.example.com/data')
            
            # 带查询参数的GET请求
            response = client.get(
                'https://api.example.com/search',
                params={'q': 'python', 'limit': 10}
            )
            
            # 自定义请求头的GET请求
            response = client.get(
                'https://api.example.com/data',
                headers={'Authorization': 'Bearer token123'}
            )
            
            # 设置超时的GET请求
            response = client.get('https://api.example.com/data', timeout=60.0)
        """
        return self._request_with_retry("GET", url, params=params, **kwargs)
        
    # def post(
    #     self,
    #     url: str,
    #     data: Optional[Dict[str, Any]] = None,
    #     json: Optional[Dict[str, Any]] = None,
    #     params: Optional[Dict[str, Any]] = None,
    #     **kwargs
    # ) -> requests.Response:
    #     """
    #     Make a POST request using the configured session.
        
    #     Args:
    #         url: URL to request
    #         data: Form data
    #         json: JSON data
    #         params: Query parameters
    #         **kwargs: Additional parameters to override session defaults
            
    #     Returns:
    #         Response object
            
    #     Raises:
    #         DownloadError: If the request fails after retries
    #     """
    #     return self._request_with_retry("POST", url, data=data, json=json, params=params, **kwargs)
    
    def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs
    ) -> requests.Response:
        """
        发送HTTP请求并在失败时自动重试，同时实现速率限制。
        
        参数:
            method: HTTP方法，如'GET'、'POST'、'PUT'、'DELETE'等
            url: 请求的URL地址
            **kwargs: 请求参数，可包含以下常用选项:
                    - params: Dict[str, Any] - URL查询参数
                    例如: {'q': 'python', 'page': 1}
                    - data: Dict[str, Any] - 表单数据(用于POST请求)
                    例如: {'username': 'user', 'password': 'pass'}
                    - json: Dict[str, Any] - JSON数据(用于POST请求)
                    例如: {'name': 'John', 'age': 30}
                    - headers: Dict[str, str] - 请求头信息
                    例如: {'Content-Type': 'application/json'}
                    - cookies: Dict[str, str] - 请求cookies
                    例如: {'session_id': '123456'}
                    - timeout: float - 请求超时时间(秒)
                    例如: 30.0
                    - allow_redirects: bool - 是否允许重定向
                    例如: True
                    - verify: bool - 是否验证SSL证书
                    例如: False
                    - stream: bool - 是否以流式方式处理响应
                    例如: True
                    - cert: str - 客户端证书路径
                    例如: '/path/to/client.pem'
                    - proxies: Dict[str, str] - 代理设置
                    例如: {'http': 'http://10.10.1.10:3128'}
                    - auth: Tuple[str, str] - 基本认证信息(用户名,密码)
                    例如: ('user', 'pass')
                    - files: Dict[str, IO] - 文件上传(用于POST请求)
                    例如: {'file': open('report.pdf', 'rb')}
        
        返回:
            requests.Response对象，包含服务器响应的完整信息
        
        异常:
            DownloadError: 当请求在达到最大重试次数后仍然失败时抛出
        
        工作流程:
            1. 应用速率限制，确保请求不会过于频繁
            2. 设置默认超时时间(如果未提供)
            3. 尝试发送请求，最多重试self.max_retries次
            4. 对特定HTTP状态码(如429、503)进行特殊处理
            5. 使用指数退避策略增加重试间隔
            6. 在所有重试失败后抛出异常
        
        使用示例:
            # 通常不直接调用此方法，而是通过client.get()或client.post()等方法间接使用
            # 但如果需要使用其他HTTP方法，可以这样调用:
            response = client._request_with_retry(
                "PATCH", 
                "https://api.example.com/resource/123",
                json={"status": "completed"}
            )
        """
        # 速率限制
        self.rate_limiter.wait()
        
        # 设置默认的超时时间
        if 'timeout' not in kwargs:
            kwargs['timeout'] = self.timeout

        
        # 尝试重试
        tries = 0
        timeout = kwargs['timeout']
        
        while tries < self.max_retries:
            try:
                # 添加随机睡眠，避免请求过于频繁
                w = random.uniform(0.5, 1.5)
                time.sleep(w)
                
                logger.debug(f"Requesting {method} {url} (attempt {tries+1}/{self.max_retries})")
                response = self.session.request(method, url, **kwargs)
                
                # 处理常见的HTTP状态码
                if response.status_code == 200:
                    return response
                elif response.status_code == 404:
                    logger.warning(f"Resource not found (404): {url}")
                    tries += 1
                    continue
                elif response.status_code == 403:
                    logger.warning(f"Access denied (403) for {url}")
                    # 如果遇到访问被拒绝，可以尝试更换会话
                    if tries < self.max_retries - 1:
                        logger.info("Creating a new session and retrying...")
                        self.session = self._create_session()
                        # 增加等待时间，避免立即重试
                        sleep_time = self.retry_delay * (2 ** tries)
                        logger.info(f"Waiting {sleep_time} seconds before retry...")
                        time.sleep(sleep_time)
                        tries += 1
                        continue
                elif response.status_code == 429 or response.status_code == 503:
                    # 处理速率限制
                    retry_after = int(response.headers.get('Retry-After', self.retry_delay * 2))
                    logger.warning(f"Rate limited (status {response.status_code}). Waiting {retry_after} seconds.")
                    time.sleep(retry_after)
                    tries += 1
                    continue
                elif response.status_code == 302 and 'Location' in response.headers:
                    # 处理重定向
                    logger.debug(f"Following redirect to: {response.headers['Location']}")
                    url = response.headers['Location']
                    continue
                else:
                    logger.warning(f"Unexpected status code: {response.status_code}")
                
                # 对于其他状态码，尝试重试
                response.raise_for_status()
                
            except requests.Timeout as e:
                logger.warning(f"Request timed out: {e}")
                # 如果超时，可以尝试增加超时时间
                if timeout < 3 * self.timeout:
                    logger.info("Increasing timeout and retrying...")
                    timeout = timeout + self.timeout
                    kwargs['timeout'] = timeout
                    tries += 1
                    continue
                logger.warning("Maximum timeout reached")
            
            except requests.ConnectionError as e:
                logger.warning(f"Connection error: {e}")
                # 连接错误可能是网络问题，等待后重试
                if tries < self.max_retries - 1:
                    sleep_time = self.retry_delay * (2 ** tries)
                    logger.info(f"Retrying in {sleep_time} seconds...")
                    time.sleep(sleep_time)
                
            except requests.RequestException as e:
                logger.warning(f"Request failed: {e}")
            
            tries += 1
            if tries < self.max_retries:
                sleep_time = self.retry_delay * (2 ** tries)  # Exponential backoff
                logger.info(f"Retrying in {sleep_time} seconds... (attempt {tries+1}/{self.max_retries})")
                time.sleep(sleep_time)
        
        # 如果所有重试都失败了
        raise DownloadError(f"Failed to {method.lower()} {url} after {self.max_retries} attempts")
    
    def download_file(
        self,
        url: str,
        save_path: Union[str, Path],
        chunk_size: int = 8192,
        **kwargs
    ) -> Path:
        """
        Download a file with retries and rate limiting.
        
        Args:
            url: URL to download
            save_path: Path to save the file
            chunk_size: Size of chunks for streaming download
            **kwargs: Additional request parameters
            
        Returns:
            Path to the downloaded file
            
        Raises:
            DownloadError: If the download fails after retries
        """
        # Ensure save_path is a Path object
        if not isinstance(save_path, Path):
            save_path = Path(save_path)
        
        # Create parent directories if they don't exist
        save_path.parent.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Downloading file from {url} to {save_path}")
        
        # Apply rate limiting
        self.rate_limiter.wait()
        
        # Set defaults for streaming download
        kwargs['stream'] = True
        
        # Try download with retries
        for attempt in range(self.max_retries):
            try:
                with self.session.get(url, **kwargs) as response:
                    response.raise_for_status()
                    
                    total_size = int(response.headers.get('content-length', 0))
                    logger.debug(f"File size: {total_size} bytes")
                    
                    with open(save_path, 'wb') as f:
                        for chunk in response.iter_content(chunk_size=chunk_size):
                            if chunk:
                                f.write(chunk)
                
                logger.info(f"Successfully downloaded to {save_path}")
                return save_path
                
            except requests.RequestException as e:
                logger.warning(f"Download failed (attempt {attempt+1}/{self.max_retries}): {e}")
                
                if attempt < self.max_retries - 1:
                    sleep_time = self.retry_delay * (2 ** attempt)  # Exponential backoff
                    logger.info(f"Retrying in {sleep_time} seconds...")
                    time.sleep(sleep_time)
                else:
                    raise DownloadError(f"Failed to download {url} after {self.max_retries} attempts: {e}")
    
# Singleton instance of NetworkClient
_default_client = None

def get_client() -> NetworkClient:
    """
    Get the default NetworkClient instance.
    
    Returns:
        NetworkClient instance
    """
    global _default_client
    if _default_client is None:
        _default_client = NetworkClient()
    return _default_client