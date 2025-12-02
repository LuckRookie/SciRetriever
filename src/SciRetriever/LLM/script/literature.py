from openai import OpenAI
from pathlib import Path
from SciRetriever.LLM.utils import llm_summary_paper

client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",
)
pdf_folder = Path("/home/test/10.1016_j.pnsc.2019.11.005.xml")
model = "qwen3-next-80b"
is_mineru = False
output_path = Path("/home/test/summary")
output_file = output_path / f"{pdf_folder.stem}_summary.md"

response_text = llm_summary_paper(pdf_folder, file_type='xml', client=client, model=model, is_mineru=is_mineru, output_file=output_file)
