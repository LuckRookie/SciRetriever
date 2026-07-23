import argparse
import importlib
import os
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from SciRetriever.LLM.script.input_validation import validate_literature_input
from SciRetriever.workspace_paths import find_workspace_root


BatchCandidate = tuple[Path, Path]
InferenceFunction = Callable[..., Any]
ProgressIterator = Callable[[list[BatchCandidate]], Iterable[BatchCandidate]]


def preflight_batch(
    input_dir: Path,
    output_dir: Path,
    file_type: str,
    is_mineru: bool,
) -> list[BatchCandidate]:
    if not input_dir.is_dir():
        raise FileNotFoundError(
            f"Input directory does not exist: {input_dir}. "
            "Pass --input-dir to select a different parsed literature asset."
        )
    if output_dir.exists() and not output_dir.is_dir():
        raise NotADirectoryError(f"Output path is not a directory: {output_dir}")

    candidates: list[BatchCandidate] = []
    for input_path in sorted(input_dir.iterdir(), key=lambda path: path.name):
        validate_literature_input(input_path, file_type, is_mineru)
        output_file = output_dir / f"{input_path.name}.md"
        if not output_file.is_file():
            candidates.append((input_path, output_file))
    return candidates


def summarize_directory(
    input_dir: Path,
    output_dir: Path,
    client: Any,
    model: str,
    file_type: str,
    is_mineru: bool,
    *,
    inference_function: InferenceFunction,
    progress_iterator: ProgressIterator,
    timeout_error: type[Exception],
    validated_candidates: list[BatchCandidate] | None = None,
) -> None:
    candidates = validated_candidates
    if candidates is None:
        candidates = preflight_batch(input_dir, output_dir, file_type, is_mineru)
    output_dir.mkdir(parents=True, exist_ok=True)
    for input_path, output_file in progress_iterator(candidates):
        try:
            inference_function(
                input_path,
                file_type=file_type,
                client=client,
                model=model,
                is_mineru=is_mineru,
                output_file=output_file,
            )
        except timeout_error:
            print("API timeout, retry...")
            inference_function(
                input_path,
                file_type=file_type,
                client=client,
                model=model,
                is_mineru=is_mineru,
                output_file=output_file,
            )


def parse_args() -> argparse.Namespace:
    workspace_root = find_workspace_root(Path(__file__))
    parser = argparse.ArgumentParser(description="Summarize a directory of literature files.")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=workspace_root / "literature" / "parsed" / "pdf2md",
        help="Input directory (default: <workspace>/literature/parsed/pdf2md).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=workspace_root / "literature" / "outputs" / "summaries",
        help="Output directory (default: <workspace>/literature/outputs/summaries).",
    )
    parser.add_argument("--file-type", choices=("xml", "html", "pdf"), default="pdf")
    parser.add_argument("--model", default="qwen3-next-80b")
    parser.add_argument("--base-url", default="http://localhost:11434/v1")
    parser.add_argument("--mineru", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    candidates = preflight_batch(args.input_dir, args.output_dir, args.file_type, args.mineru)
    openai = importlib.import_module("openai")
    llm_utils = importlib.import_module("SciRetriever.LLM.utils")
    tqdm = importlib.import_module("tqdm")
    client = openai.OpenAI(
        base_url=args.base_url,
        api_key=os.environ.get("SCIRETRIEVER_LLM_API_KEY", "ollama"),
    )
    summarize_directory(
        args.input_dir,
        args.output_dir,
        client,
        args.model,
        args.file_type,
        args.mineru,
        inference_function=llm_utils.llm_summary_paper,
        progress_iterator=tqdm.tqdm,
        validated_candidates=candidates,
        timeout_error=openai.APITimeoutError,
    )


if __name__ == "__main__":
    main()
