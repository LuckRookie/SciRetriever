"""
Network client for making HTTP requests with rate limiting and retries.
"""
from http.client import USE_PROXY
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Union, Any, Tuple

import requests
from bs4 import BeautifulSoup

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
    """Rate limiter to prevent too many requests to a server."""
    
    def __init__(self, rate_limit: float = None):
        """
        Initialize rate limiter.
        
        Args:
            rate_limit: Minimum seconds between requests, None to use config
        """
        self.config = get_config()
        self.rate_limit = rate_limit or self.config.get("download.rate_limit", 5.0)
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
    """Manages proxy settings for network requests."""
    
    def __init__(self,http:str=None,https:str=None):
        """Initialize proxy settings."""
        self.http = http
        self.https = https
        self._proxies = {
            'http': self.http,
            'https': self.https
        }
    def get_proxies(self) -> Dict[str, str]:
        """Return the current proxy settings."""
        return self._proxies
    @classmethod
    def from_config(cls, config: Dict[str, str]) -> 'Proxy':
        """Create a Proxy object from a configuration dictionary."""
        return cls(
            http=config.get('http'),
            https=config.get('https')
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
        use_proxy: bool = True,
        headers: Optional[Dict[str, str]] = None,
        allow_redirects: bool = True,
        verify: bool = True
    ):
        """
        Initialize network client.
        
        Args:
            rate_limit: Minimum seconds between requests
            max_retries: Maximum number of retries for failed requests
            retry_delay: Delay between retries in seconds
            timeout: Request timeout in seconds
            user_agent: User agent string for requests
            use_proxy: Whether to use proxy settings if available
            headers: Default HTTP headers for all requests
            allow_redirects: Whether to follow redirects by default
            verify: Whether to verify SSL certificates by default
        """
        self.config = get_config()
        self.rate_limiter = RateLimiter(rate_limit)
        self.max_retries = max_retries or self.config.get("download.max_retries", 3)
        self.retry_delay = retry_delay or self.config.get("download.retry_delay", 2.0)
        self.timeout = timeout or self.config.get("download.timeout", 30.0)
        self.use_proxy = use_proxy
        
        # Set up user agent
        if not user_agent:
            user_agent = self._get_user_agent()
        self.user_agent = user_agent
        
        # Set default request settings
        self.default_headers = headers or {}
        if 'User-Agent' not in self.default_headers:
            self.default_headers['User-Agent'] = self.user_agent
            
        # Add common headers
        if 'accept-language' not in self.default_headers:
            self.default_headers['accept-language'] = 'en-US,en'
        if 'accept' not in self.default_headers:
            self.default_headers['accept'] = 'text/html,application/xhtml+xml,application/xml'
        
        self.allow_redirects = allow_redirects
        self.verify = verify
        
        # Create session
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
        try:
            from fake_useragent import UserAgent
            FAKE_USERAGENT = True
        except Exception:
            FAKE_USERAGENT = False
            DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36'
        
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
    
    def _create_session(self) -> requests.Session:
        """Create and configure a requests session."""
        session = requests.Session()
        # Set default headers for all requests through this session
        session.headers.update(self.default_headers)
        # Apply proxy settings if available and enabled
        if self.use_proxy:
            proxy = Proxy.from_config(self.config)
            proxy_settings = proxy.get_proxies()
            if proxy_settings and (proxy_settings.get('http') or proxy_settings.get('https')):
                session.proxies.update(proxy_settings)
                logger.info(f"Applied proxy: {proxy_settings}")
        
        return session
    
    def get(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> requests.Response:
        """
        Make a GET request using the configured session.
        
        Args:
            url: URL to request
            params: Query parameters
            **kwargs: Additional parameters to override session defaults
            
        Returns:
            Response object
            
        Raises:
            DownloadError: If the request fails after retries
        """
        return self._request_with_retry("GET", url, params=params, **kwargs)
    
    def post(
        self,
        url: str,
        data: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> requests.Response:
        """
        Make a POST request using the configured session.
        
        Args:
            url: URL to request
            data: Form data
            json: JSON data
            params: Query parameters
            **kwargs: Additional parameters to override session defaults
            
        Returns:
            Response object
            
        Raises:
            DownloadError: If the request fails after retries
        """
        return self._request_with_retry("POST", url, data=data, json=json, params=params, **kwargs)
    
    def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs
    ) -> requests.Response:
        """
        Make a request with retries and rate limiting.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            url: URL to request
            **kwargs: Request parameters
            
        Returns:
            Response object
            
        Raises:
            DownloadError: If the request fails after retries
        """
        # Apply rate limiting
        self.rate_limiter.wait()
        
        # Set default timeout if not provided
        if 'timeout' not in kwargs:
            kwargs['timeout'] = self.timeout
        
        # Set default allow_redirects and verify if not provided
        if 'allow_redirects' not in kwargs:
            kwargs['allow_redirects'] = self.allow_redirects
        if 'verify' not in kwargs:
            kwargs['verify'] = self.verify
        
        # Try request with retries
        for attempt in range(self.max_retries):
            try:
                response = self.session.request(method, url, **kwargs)
                
                # Check for rate limiting response
                if response.status_code in (429, 503):
                    retry_after = int(response.headers.get('Retry-After', self.retry_delay * 2))
                    logger.warning(f"Rate limited by server. Waiting {retry_after} seconds.")
                    time.sleep(retry_after)
                    continue
                
                # Raise exception for other error status codes
                response.raise_for_status()
                
                return response
                
            except requests.RequestException as e:
                logger.warning(f"Request failed (attempt {attempt+1}/{self.max_retries}): {e}")
                
                if attempt < self.max_retries - 1:
                    sleep_time = self.retry_delay * (2 ** attempt)  # Exponential backoff
                    logger.info(f"Retrying in {sleep_time} seconds...")
                    time.sleep(sleep_time)
                else:
                    raise DownloadError(f"Failed to {method.lower()} {url} after {self.max_retries} attempts: {e}")
    
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
        if 'timeout' not in kwargs:
            kwargs['timeout'] = self.timeout
        if 'verify' not in kwargs:
            kwargs['verify'] = self.verify
        
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