def filter_title(words:list[str],title:str) -> bool:
    if any(word in title.lower() for word in words):
        return True
    else:
        return False