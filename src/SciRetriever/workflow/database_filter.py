from SciRetriever.database.optera import Query, Delete


def filter_duplicate_paper(db_dir: str):
    """
    根据论文标题和DOI去重，只要同时重复就判定为重复数据
    对于DOI为空的情况，仅比较标题
    
    Args:
        db_dir: 数据库目录路径
    """
    query = Query.connect_db(db_dir=db_dir)
    papers = query.query_all(limit=None)
    
    # 维护两个集合：标题集合和DOI集合
    seen_titles = set()
    seen_dois = set()
    duplicate_ids = []
    
    for paper in papers:
        title = paper.title.lower().strip()
        doi = paper.doi.lower().strip() if paper.doi else ""
        
        # DOI为空时仅比较标题
        if doi == "":
            if title in seen_titles:
                duplicate_ids.append(paper.id)
            else:
                seen_titles.add(title)
        # DOI不为空时比较标题或DOI
        else:
            if title in seen_titles and doi in seen_dois:
                duplicate_ids.append(paper.id)
            else:
                seen_titles.add(title)
                seen_dois.add(doi)

    # 执行删除
    if duplicate_ids:
        delete = Delete.connect_db(db_dir=db_dir)
        delete.delete_paper_id(duplicate_ids)
        print(f"Deleted {len(duplicate_ids)} duplicate papers")
    else:
        print("No duplicate papers found")