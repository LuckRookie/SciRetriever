import tqdm
from openai import APITimeoutError
from openai import OpenAI
from pathlib import Path
from SciRetriever.LLM.utils import llm_summary_paper

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",
)
model = "qwen3-next-80b"
is_mineru = True
output_path = Path("/home/test/summary")
exist_list = list(output_path.iterdir())
exist_list = [pdf.name.split(".")[0] for pdf in exist_list]
# batch inference
pdf_list = list(Path("/home/test/pdf2md/").iterdir())
pdf_list = [pdf for pdf in pdf_list if pdf.name.split(".")[0] not in exist_list]

for pdf in tqdm.tqdm(pdf_list):
    output_file = output_path / f"{pdf.name}.md"
    try:
        response = llm_summary_paper(pdf, file_type='pdf', client=client, model=model, is_mineru=is_mineru, output_file=output_file)
    except APITimeoutError:
        print("API timeout, retry...")
        response = llm_summary_paper(pdf, file_type='pdf', client=client, model=model, is_mineru=is_mineru, output_file=output_file)