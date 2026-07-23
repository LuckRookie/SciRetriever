from openai import OpenAI
import json
from pathlib import Path
import time
import tqdm
from openai import APITimeoutError
from .prompt.literature import PROMPT
def llm_inference(
    client:OpenAI,
    model:str,
    prompt:str,
    text:str
    ):
    """
    client: OpenAI 客户端
    model: 模型名称
    prompt: 提示词
    text: 输入文本
    """
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": text}
            ],
    )
    return response

def llm_summary_paper(
    file_path:str|Path, 
    file_type:str,
    client:OpenAI,
    model = "qwen3-next-80b",
    is_mineru:bool=True,
    output_file:str | Path | None = None
    ):
    """
    file_path: 论文文件路径
    client: OpenAI 客户端
    model: 模型名称
    is_mineru: 是否获取mineru的页眉
    """
    file_path = Path(file_path)
    
    if not file_path.exists():
        raise FileNotFoundError(f"文件 {file_path} 不存在")
    # read prompt
    prompt = PROMPT
    
    if file_type.lower() == 'pdf':
        # read text
        pdf_path = file_path / 'auto' / f"{file_path.name}.md"
        with open(pdf_path, "r") as f:
            text = f.read()
        # add mineru info
        if is_mineru:
            with open(file_path / 'auto' / f"{file_path.name}_middle.json", "r") as f:
                data = json.load(f)
                first_discarded = data['pdf_info'][0]['discarded_blocks']
                text = text + '\nAdditonal information:\n' + json.dumps(first_discarded, ensure_ascii=False)
    elif file_type.lower() == 'xml':
        # read text
        xml_path = file_path
        with open(xml_path, "r") as f:
            text = f.read()
    elif file_type.lower() == 'html':
        # read text
        html_path = file_path
        with open(html_path, "r") as f:
            text = f.read()
    else:
        raise ValueError(f"不支持的文件类型 {file_type}")
    # inference
    response = llm_inference(
        client=client,
        model=model,
        prompt=prompt,
        text=text
    )
    # write
    if output_file is not None:
        with open(output_file, "w") as f:
            f.write(response.choices[0].message.content)
    return response.choices[0].message.content