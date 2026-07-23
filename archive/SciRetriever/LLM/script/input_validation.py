from pathlib import Path


def validate_literature_input(input_path: Path, file_type: str, is_mineru: bool) -> list[Path]:
    if file_type in {"xml", "html"}:
        if is_mineru:
            raise ValueError("--mineru is only valid with --file-type pdf.")
        if not input_path.is_file():
            raise FileNotFoundError(f"Input {file_type.upper()} file does not exist: {input_path}")
        return [input_path]
    if file_type != "pdf":
        raise ValueError(f"Unsupported literature file type: {file_type}")
    if not input_path.is_dir():
        raise FileNotFoundError(f"MinerU result directory does not exist: {input_path}")
    auto = input_path / "auto"
    required = [auto / f"{input_path.name}.md"]
    if is_mineru:
        required.append(auto / f"{input_path.name}_middle.json")
    missing = [path for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing required MinerU input: {missing[0]}")
    return required
