from SciRetriever.retriver.wiley import WileyClient,WileyRetriver

api_key = "xxxx"
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
