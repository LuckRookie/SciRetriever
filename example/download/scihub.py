import importlib
import os
from pathlib import Path
from time import sleep
import requests

api_key = os.environ.get("SCIHUB_API_KEY")
if not api_key:
    raise RuntimeError("SCIHUB_API_KEY is required.")

database_model = importlib.import_module("SciRetriever.database.model")
optera_module = importlib.import_module("SciRetriever.database.optera")
scihub = importlib.import_module("SciRetriever.retriver.scihub")
Paper = database_model.Paper
Optera = optera_module.Optera
ScihubClient = scihub.ScihubClient
ScihubRetriver = scihub.ScihubRetriver
client = ScihubClient(
    rate_limit=30,
)
retriver = ScihubRetriver(
    client=client,
)

database = os.environ.get("SCIRETRIEVER_DOWNLOAD_DB")
if not database:
    raise RuntimeError("SCIRETRIEVER_DOWNLOAD_DB must name an existing database.")
optera = Optera.connect_db(database, create_db=False)
pdf_download_path = Path("./scihub")

session = optera.sessionfactory()

query = session.query(Paper)
query = query.filter(Paper.pdf_downloaded == False, Paper.doi.isnot(None))
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
