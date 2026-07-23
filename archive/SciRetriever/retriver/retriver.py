import abc
from ..network import NetworkClient
from ..utils.logging import get_logger

logger = get_logger(__name__)
# 根据出版商和期刊进行文献下载
'''
https://ua-libraries-research-data-services.github.io/UALIB_ScholarlyAPI_Cookbook/src/python/springer.html
查看各种出版商的API的使用方法
'''
class BaseRetriver(abc.ABC):
    def __init__(
        self,
        client: NetworkClient,
        ):
        """
        Initialize the Retriver.
        """
        self.client = client