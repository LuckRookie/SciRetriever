import argparse
import json
import os
from pathlib import Path

from openai import OpenAI
from SciRetriever.LLM.prompt.synthesis import PROMPT
from SciRetriever.LLM.utils import llm_inference
from SciRetriever.workspace_paths import find_workspace_root


def extract_synthesis(input_path: Path, output_dir: Path, client: OpenAI, model: str) -> Path:
    text = input_path.read_text(encoding="utf-8")
    response = llm_inference(client=client, model=model, prompt=PROMPT, text=text)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"{input_path.stem}.json"
    data = json.loads(response.choices[0].message.content)
    output_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output_file


def parse_args() -> argparse.Namespace:
    workspace_root = find_workspace_root(Path(__file__))
    parser = argparse.ArgumentParser(description="Extract synthesis data from one Markdown file.")
    parser.add_argument("input", type=Path, help="Input Markdown file.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=workspace_root / "literature" / "outputs" / "routes",
        help="JSON output directory (default: <workspace>/literature/outputs/routes).",
    )
    parser.add_argument("--model", default="qwen3-next-80b")
    parser.add_argument("--base-url", default="http://localhost:11434/v1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = OpenAI(
        base_url=args.base_url,
        api_key=os.environ.get("SCIRETRIEVER_LLM_API_KEY", "ollama"),
    )
    extract_synthesis(args.input, args.output_dir, client, args.model)


if __name__ == "__main__":
    main()
