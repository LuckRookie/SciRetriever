import importlib
import os

api_key = os.environ.get("WILEY_TDM_API_KEY")
if not api_key:
    raise RuntimeError("WILEY_TDM_API_KEY is required.")

wiley = importlib.import_module("SciRetriever.retriver.wiley")
WileyClient = wiley.WileyClient
WileyRetriver = wiley.WileyRetriver
client = WileyClient(
    api_key=api_key,
    rate_limit=10,
)
doi = "10.1002/fam.2793"
retriver = WileyRetriver(
    client=client,
)
retriver.download_pdf(
    doi=doi,
    # file_path=f"./{file_name}/{file_name}.pdf",
)
