import os
import requests
from bs4 import BeautifulSoup
from bs4._typing import _OneElement
import json
from typing import Any, Dict, List, Optional, Union
from pathlib import Path

class CJEM:
    def __init__(self,issue:str):
        # https://energetic-materials.org.cn/
        
        self.article_url:str = "https://energetic-materials.org.cn/hncl/article/issue/"
        self.pdf_list:list[dict] = []
        self.issue = issue
        
    def get_issue(self):
        issue_url = self.article_url + self.issue
        response = requests.get(issue_url)
        response.encoding = 'utf-8'
        return response

    def parse_issue(self,issue_response:requests.Response):
        if issue_response.status_code == 200:
            # 使用BeautifulSoup解析网页内容
            soup = BeautifulSoup(issue_response.text, 'lxml')

            article_list = soup.find('div',class_="article_list")
            li = article_list.find_all('li',class_="article_line")
            self.clean_pdf_list()
            
            for i in li:
                if self.filter_li(i):
                    pdf = self.li2dict(i)
                    self.pdf_list.append(pdf)
        else:
            print("请求失败，状态码：", issue_response.status_code)
    
    def load_pdf_list(self):
        issue_response = self.get_issue()
        self.parse_issue(issue_response)
    
    def get_pdf_list(self):
        return self.pdf_list
    
    def clean_pdf_list(self):
        self.pdf_list = []
    
    def filter_li(self,li:_OneElement):
        authors = [author.text for author in li.find('p',class_="article_author").find_all("a")]
        title = li.find('div',class_="article_title").text.strip()
        if "含能快递" in title:
            return False
        if "《含能材料》编辑部" in authors:
            return False
        return True
        
    def li2dict(self,li:_OneElement):
        title = li.find('div',class_="article_title").text.strip()
        code = li.find('input').get('value')
        down_url = f"https://energetic-materials.org.cn/hncl/article/pdf/{code}?st=article_issue"
        doi = li.find('p',class_="article_position").find("a").text
        doi_url = li.find('p',class_="article_position").find("a").get('href')
        authors = [author.text for author in li.find('p',class_="article_author").find_all("a")]
        return {
            "title": title,
            "code": code,
            "pdf_url": down_url,
            "doi": doi,
            "doi_url": doi_url,
            "authors": authors
            }
    
    def export_json(self,save_path:Union[str,Path]):
        if not isinstance(save_path,Path):
            save_path = Path(save_path)
        save_path.mkdir(parents=True,exist_ok=True)
        with open(save_path / f"{self.issue}.json","w") as f:
            json.dump(self.pdf_list,f,ensure_ascii=False,indent=4)
    
    def download_pdf(self,save_path:Union[str,Path]):
        if not isinstance(save_path,Path):
            save_path = Path(save_path) / self.issue
        save_path.mkdir(parents=True,exist_ok=True)
        for dict in self.pdf_list:
            pdf_url = dict["pdf_url"]
            pdf_name = dict["code"]
            
            # 开始下载
            print(f"开始下载 {pdf_name}.pdf")
            self.download(pdf_path=save_path / f"{pdf_name}.pdf",pdf_url=pdf_url)
            
    @staticmethod
    def download(pdf_path:Union[str,Path],pdf_url:str):
        with requests.get(pdf_url,stream=True) as r:
            r.raise_for_status()
            with open(pdf_path,'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
                    
    def check_have_issue(self,response:requests.Response):
        if response.status_code != 200:
            raise Exception("CJEM: 请求失败")
        
        soup = BeautifulSoup(response.text, 'lxml')
        index_info_left = soup.find('div', class_='index_info_left')
        
        if not index_info_left.find('div',class_="article_issue_container"):
            return False
        return True
class CJEM_ALL:
    """
    CJEM: 1993-NEWEST
    Article Format: YEAR_VOLUME_ISSUE (e.g. 2020_5_1),2020年第5卷第1期
    Year -> VOLUME: 1993 -> 1, 1994 -> 2, ..., 2025 -> 33
    """ 
    def __init__(self,work_dir:Union[str,Path]=Path.cwd(),volume:Union[str,int]=33,year:Union[str,int]=2025):
        if not isinstance(work_dir,Path):
            work_dir = Path(work_dir)
        self.work_dir = work_dir
        
        self.all_volume = range(1,int(volume)+1)
        self.all_year = range(1993,int(year)+1)
        self.all_issue = [item.name for item in self.work_dir.iterdir() if item.is_dir()]
    
    def download_all(self,download_pdf:bool=False):
        done_issue = self.all_issue.copy()
        
        for volume,year in zip(self.all_volume,self.all_year):
            no = 1
            while True:
                issue = f"{year}_{volume}_{no}"
                
                if issue in done_issue:
                    no += 1
                    print(f"{year}年第{volume}卷第{no}期已经下载过，跳过")
                    continue
                
                try:
                    cjem = CJEM(issue)
                    # 发送请求
                    response = cjem.get_issue()
                    if cjem.check_have_issue(response):
                        print(f"开始解析{year}年第{volume}卷第{no}期")
                        self.all_issue.append(issue)
                        cjem.parse_issue(response)
                        if download_pdf:
                            cjem.download_pdf(self.work_dir/issue)
                        cjem.export_json(self.work_dir)
                        no += 1
                    else:
                        break
                except Exception as e:
                    print(e)
                    
    def get_all_issue(self):
        return self.all_issue
        
if __name__ == "__main__":
    # cjem = CJEM("1993_1_5")
    # # cjem.load_pdf()
    # response = cjem.get_issue()
    # print(response)
    # print(response.text)
    
    
    # print(cjem.get_pdf_list())
    # # cjem.download("/workplace/duanjw/pdf/CJEM")
    # cjem.export_json("/workplace/duanjw/pdf/CJEM")
    
    cjem = CJEM_ALL(work_dir="/workplace/duanjw/pdf/CJEM")
    cjem.download_all(download_pdf=True)
    
