from openai import OpenAI
import json
from pathlib import Path
from SciRetriever.LLM.prompt.synthesis import PROMPT
from SciRetriever.LLM.utils import llm_inference
# config
client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama",
)
# pdf_folder = Path("/workplace/home/duanjw/project/mineru/d1ra00651g")
md_path = Path("/home/test/test.md")

prompt = PROMPT

output_path = Path("/home/test")
with open(md_path, "r") as f:
    text = f.read()
    
# inference
# text = "1‑偕二硝基‑3‑硝基‑5‑叠氮吡唑钾盐（2）的合成：取 50 mL 的茄型瓶，量取 15 mL 甲醇加入其中，称取 0.348 g (2 mmol) 的 KI加入其中使其溶解，然后称取 0.303 g (1 mmol) 的1‑三硝基甲基‑3‑硝基‑5叠氮吡唑溶于 4 mL 甲醇中；将其逐滴加入上述反应体系中，溶液由白色变为黄色，然后逐渐变为黑色。搅拌 15 min 后产生沉淀，过滤，用甲醇洗涤沉淀，晾干后得到白色固体 0.11 g ，产率为 37.2%。"
response = llm_inference(
    client = client,
    model="qwen3-next-80b",
    prompt = PROMPT,
    text = text,
)

# write
with open(output_path / f"{md_path.stem}.json", "w") as f:
    data = json.loads(response.choices[0].message.content)
    json.dump(data, f, ensure_ascii=False,indent=2)