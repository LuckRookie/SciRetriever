import importlib
import os
from pathlib import Path
from time import sleep
import requests

api_key = os.environ.get("ELSEVIER_API_KEY")
if not api_key:
    raise RuntimeError("ELSEVIER_API_KEY is required.")

database_model = importlib.import_module("SciRetriever.database.model")
optera_module = importlib.import_module("SciRetriever.database.optera")
elsevier = importlib.import_module("SciRetriever.retriver.elsevier")
Paper = database_model.Paper
Optera = optera_module.Optera
ElsevierClient = elsevier.ElsevierClient
ElsevierRetriver = elsevier.ElsevierRetriver
client = ElsevierClient(
    api_key=api_key,
    rate_limit=30,
)
retriver = ElsevierRetriver(
    client=client,
)

database = os.environ.get("SCIRETRIEVER_DOWNLOAD_DB")
if not database:
    raise RuntimeError("SCIRETRIEVER_DOWNLOAD_DB must name an existing database.")
optera = Optera.connect_db(database, create_db=False)
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
