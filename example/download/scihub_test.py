from SciRetriever.retriver.scihub import ScihubClient,ScihubRetriver
client = ScihubClient(
    rate_limit=10,
)
retriver = ScihubRetriver(
    client=client,
)
retriver.download_pdf(
    doi='10.4028/www.scientific.net/kem.723.789',
    download_path='./work',
)
