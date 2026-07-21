import argparse
import importlib
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from SciRetriever.LLM.script.input_validation import validate_literature_input
from SciRetriever.workspace_paths import find_workspace_root


InferenceFunction = Callable[..., Any]


def summarize_literature(
    input_path: Path,
    output_file: Path,
    file_type: str,
    client: Any,
    model: str,
    is_mineru: bool,
    *,
    inference_function: InferenceFunction | None = None,
) -> None:
    validate_literature_input(input_path, file_type, is_mineru)
    inference = inference_function
    if inference is None:
        llm_utils = importlib.import_module("SciRetriever.LLM.utils")
        inference = llm_utils.llm_summary_paper
    output_file.parent.mkdir(parents=True, exist_ok=True)
    inference(
        input_path,
        file_type=file_type,
        client=client,
        model=model,
        is_mineru=is_mineru,
        output_file=output_file,
    )


def parse_args() -> argparse.Namespace:
    workspace_root = find_workspace_root(Path(__file__))
    parser = argparse.ArgumentParser(description="Summarize one literature input.")
    parser.add_argument(
        "input",
        type=Path,
        help="XML/HTML file, or MinerU result directory for --file-type pdf.",
    )
    parser.add_argument(
        "--file-type",
        choices=("xml", "html", "pdf"),
        default="xml",
        help="Input layout: xml/html file or pdf MinerU result directory.",
    )
    parser.add_argument("--output", type=Path, help="Output Markdown file.")
    parser.add_argument("--model", default="qwen3-next-80b")
    parser.add_argument("--base-url", default="http://localhost:11434/v1")
    parser.add_argument(
        "--mineru",
        action="store_true",
        help="For PDF MinerU directories, also require and include auto/<name>_middle.json.",
    )
    args = parser.parse_args()
    if args.output is None:
        args.output = workspace_root / "literature" / "outputs" / "summaries" / f"{args.input.stem}_summary.md"
    return args


def main() -> None:
    args = parse_args()
    validate_literature_input(args.input, args.file_type, args.mineru)
    openai = importlib.import_module("openai")
    llm_utils = importlib.import_module("SciRetriever.LLM.utils")
    client = openai.OpenAI(
        base_url=args.base_url,
        api_key=os.environ.get("SCIRETRIEVER_LLM_API_KEY", "ollama"),
    )
    summarize_literature(
        args.input,
        args.output,
        args.file_type,
        client,
        args.model,
        args.mineru,
        inference_function=llm_utils.llm_summary_paper,
    )


if __name__ == "__main__":
    main()
