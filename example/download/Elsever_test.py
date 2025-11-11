from SciRetriever.retriver.elsevier import ElsevierClient,ElsevierRetriver
api_key = "xxxx"
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
