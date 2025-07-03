from pathlib import Path
import time
from ..searcher import GSClient,GoogleScholarSearcher,GSWorkplace
from ..utils.logging import get_logger, setup_logging
logger = get_logger(__name__)

def run_year(
    query:str,
    is_fill:bool=False,
    start_year:int = 2000,
    cut_year:int = 2025,
    session:GSClient|None = None,
    root_dir:str|Path|None = None,
    max_cycles:int = 5,
    log_path:str|Path|None = None,
    ):
    if root_dir is None:
        root_dir = Path.cwd()
        
    if isinstance(root_dir,str):
        root_dir = Path(root_dir)
        
    if log_path is None:
        log_path = root_dir / "logs" / 'sciretriever.log'
    
    if isinstance(log_path,str):
        log_path = Path(log_path)
        
    setup_logging(log_file = log_path)
    
    searcher = GoogleScholarSearcher(client=session)
    
    for year in range(cut_year,start_year-1,-1):
        year_dir = root_dir / f"{year}"
        logger.info(f"开始下载{year}年")
        if not year_dir.exists():
            logger.warning(f"{year_dir}不存在,将创建")
            year_dir.mkdir(parents=True, exist_ok=True)
        try:
            totle_GS = GSWorkplace.from_root_dir(year_dir,session=session)
        except FileNotFoundError:
            logger.info("未找到page_1.json,将重新下载")
            result = searcher.search_publication(query,year_low=year,year_high=year)
            totle_GS = GSWorkplace(start_page=result,root_dir=year_dir)

        if not totle_GS.pages[-1].next_url and not (is_fill and not all([page.filled for page in totle_GS.pages])):
            logger.info(f"{year}年已经下载完成")
            continue
        
        for _ in range(max_cycles):
            try:
                totle_GS.run(is_fill=is_fill)

            except IndexError as e:
                logger.error(f"{year}年下载失败,错误信息:{e}")
                logger.error(f"重新下载{year}年")
            except StopIteration as e:
                break
            
        logger.info(f"{year}年下载完成")
        time.sleep(60)
        continue
