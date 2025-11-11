from pathlib import Path
from time import sleep
import requests

from SciRetriever.database.model import Paper
from SciRetriever.database.optera import Optera
from SciRetriever.retriver.wiley import WileyClient,WileyRetriver
api_key = "xxx"
client = WileyClient(
    api_key=api_key,
    rate_limit=30,
)
retriver = WileyRetriver(
    client=client,
)

optera = Optera.connect_db("all.db")
pdf_download_path = Path("./wiley")

session = optera.sessionfactory()

query = session.query(Paper)
query = query.filter(Paper.publisher == "Wiley", Paper.doi.isnot(None))
papers = query.all()
for paper in papers:
    if '/' in paper.doi:
        name = paper.doi.replace('/','_')
    else:
        name = paper.doi
    try:
        retriver.download_pdf(
            doi=paper.doi,
            download_path=pdf_download_path,
        )
        paper.pdf_downloaded = True
        paper.pdf_path = str(pdf_download_path / f"{name}.pdf")
        session.commit()
        
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            print(f"Download {name} failed, error: {e}")
            continue
        
        sleep(120)
        retriver.download_pdf(
            doi=paper.doi,
            download_path=pdf_download_path,
        )
    except Exception as e:
        print(f"Download {name} failed, error: {e}")
        continue

session.close()
