import os
import stat
from pathlib import Path


WORKSPACE_MARKER = ".workspace-root"
WORKSPACE_MARKER_CONTENT = b"duanjw-research-workspace:v1\n"
WORKSPACE_ROOT_ENV = "SCIRETRIEVER_WORKSPACE_ROOT"


def _has_valid_workspace_marker(directory: Path) -> bool:
    marker = directory / WORKSPACE_MARKER
    try:
        info = marker.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or marker.is_symlink():
        raise RuntimeError(f"Invalid workspace marker: {marker}")
    try:
        content = marker.read_bytes()
    except OSError as error:
        raise RuntimeError(f"Unable to read workspace marker: {marker}") from error
    if content != WORKSPACE_MARKER_CONTENT:
        raise RuntimeError(f"Malformed workspace marker: {marker}")
    return True


def _require_workspace_repository(workspace_root: Path, repository_root: Path | None) -> None:
    if repository_root is None:
        return
    expected = workspace_root / "literature" / "retrieval" / "SciRetriever"
    if not expected.is_dir() or expected.is_symlink() or expected.resolve() != repository_root:
        raise RuntimeError(
            f"Workspace {workspace_root} does not contain the active SciRetriever repository "
            f"at {expected}."
        )


def find_workspace_root(start: Path | None = None) -> Path:
    """Resolve the workspace through its exact project-owned marker."""
    try:
        repository_root = find_repository_root(start)
    except RuntimeError:
        repository_root = None

    override = os.environ.get(WORKSPACE_ROOT_ENV)
    if override:
        workspace_root = Path(override).expanduser().resolve()
        if not workspace_root.is_dir() or not _has_valid_workspace_marker(workspace_root):
            raise RuntimeError(f"{WORKSPACE_ROOT_ENV} must contain a valid {WORKSPACE_MARKER} marker.")
        _require_workspace_repository(workspace_root, repository_root)
        return workspace_root

    current = (start or Path(__file__)).resolve()
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if _has_valid_workspace_marker(candidate):
            _require_workspace_repository(candidate, repository_root)
            return candidate
    raise RuntimeError(
        f"Unable to find the workspace root containing a valid {WORKSPACE_MARKER} marker; "
        f"set {WORKSPACE_ROOT_ENV} or pass an explicit CLI path."
    )


def find_repository_root(start: Path | None = None) -> Path:
    """Find the SciRetriever repository from a script or package path."""
    current = (start or Path(__file__)).resolve()
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / "pyproject.toml").is_file() and (candidate / "src" / "sciretriever").is_dir():
            return candidate
    raise RuntimeError("Unable to find the SciRetriever repository root.")
