import re
from dataclasses import dataclass, field
from typing import List

@dataclass
class KeywordGroup:
    """
    定义一个筛选维度（例如：'金属类型' 或 '发光性质'）。
    逻辑：组内是 OR 关系（命中任意一个词即可）。
    """
    name: str  # 组名，方便调试，如 "Research Object"
    strict_terms: List[str] = field(default_factory=list)  # 需要全词匹配的词 (如 "Co", "AI", "C")
    fuzzy_terms: List[str] = field(default_factory=list)   # 可以模糊匹配的词 (如 "Cobalt", "Machine Learning")

    def match(self, text: str) -> bool:
        """判断文本是否命中该组"""
        text_lower = text.lower()

        # 1. 模糊匹配 (Substring match)
        # 适用于长难词，效率高
        if any(term.lower() in text_lower for term in self.fuzzy_terms):
            return True

        # 2. 严格全词匹配 (Regex Word Boundary)
        # 适用于短词、缩写，防止噪音
        if self.strict_terms:
            # 构造正则: \b(Co|Fe|NO)\b，忽略大小写
            pattern = r'\b(' + '|'.join(re.escape(w) for w in self.strict_terms) + r')\b'
            if re.search(pattern, text, re.IGNORECASE):
                return True
        
        return False

class UniversalFilter:
    """
    通用筛选引擎。
    逻辑：
    1. 必须不包含 exclude_terms 中的任一词 (NOT)
    2. 必须同时命中所有 required_groups (AND)
    """
    def __init__(self, required_groups: List[KeywordGroup], exclude_terms: List[str] = None):
        self.groups = required_groups
        self.exclude_terms = exclude_terms if exclude_terms else []

    def check(self, text: str) -> bool:
        if not text:
            return False
        
        text_lower = text.lower()

        # 1. 检查黑名单 (Veto logic)
        if any(bad_word.lower() in text_lower for bad_word in self.exclude_terms):
            return False

        # 2. 检查所有必须满足的组 (Intersection logic)
        # 必须所有组都返回 True，结果才为 True
        for group in self.groups:
            if not group.match(text):
                return False  # 只要有一个组没命中，直接失败
        
        return True
