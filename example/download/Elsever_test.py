import importlib
import os

api_key = os.environ.get("ELSEVIER_API_KEY")
if not api_key:
    raise RuntimeError("ELSEVIER_API_KEY is required.")

elsevier = importlib.import_module("SciRetriever.retriver.elsevier")
ElsevierClient = elsevier.ElsevierClient
ElsevierRetriver = elsevier.ElsevierRetriver
client = ElsevierClient(
    api_key=api_key,
    rate_limit=10,
)
retriver = ElsevierRetriver(
    client=client,
)
retriver.download_xml(
    doi='10.1016/j.enmf.2020.12.004',
    # path='./',
)
