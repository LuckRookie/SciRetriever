from pathlib import Path
from time import sleep
import requests

from SciRetriever.database.model import Paper
from SciRetriever.database.optera import Optera
from SciRetriever.retriver.elsevier import ElsevierClient,ElsevierRetriver
api_key = "xxx"
client = ElsevierClient(
    api_key=api_key,
    rate_limit=30,
)
retriver = ElsevierRetriver(
    client=client,
)

optera = Optera.connect_db("all.db")
pdf_download_path = Path("./Elsever")

session = optera.sessionfactory()

query = session.query(Paper)
query = query.filter(Paper.publisher == "Elsevier", Paper.doi.isnot(None))
papers = query.all()
for paper in papers:
    if '/' in paper.doi:
        name = paper.doi.replace('/','_')
    else:
        name = paper.doi
    try:
        retriver.download_xml(
            doi=paper.doi,
            download_path=pdf_download_path,
        )
        paper.pdf_downloaded = True
        paper.pdf_path = str(pdf_download_path / f"{name}.xml")
        session.commit()
        
    except requests.exceptions.HTTPError as e:
        sleep(120)
        retriver.download_xml(
            doi=paper.doi,
            download_path=pdf_download_path,
        )
    except Exception as e:
        print(f"Download {name} failed, error: {e}")
        continue

session.close()
