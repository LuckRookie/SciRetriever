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


def find_workspace_root_for_target(path: Path) -> Path | None:
    """Find a valid workspace marker by walking upward from an explicit target."""
    resolved = path.expanduser().resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for candidate in (current, *current.parents):
        if _has_valid_workspace_marker(candidate):
            expected = candidate / "literature" / "retrieval" / "SciRetriever"
            if not expected.is_dir() or expected.is_symlink():
                raise RuntimeError(
                    f"Workspace {candidate} does not contain a real SciRetriever repository at {expected}."
                )
            return candidate
    return None


def require_staged_write_override(
    path: Path,
    *,
    allow_staged_write: bool,
    start: Path | None = None,
) -> Path:
    """Reject writes into the staged repository unless explicitly overridden."""
    resolved = path.expanduser().resolve()
    if allow_staged_write:
        return resolved
    try:
        repository_root = find_repository_root(start)
    except RuntimeError:
        target_workspace = find_workspace_root_for_target(resolved)
        if target_workspace is None:
            return resolved
        staged_root = (
            target_workspace / "literature" / "retrieval" / "SciRetriever"
        ).resolve()
        if resolved.is_relative_to(staged_root) and not allow_staged_write:
            raise PermissionError(
                f"Refusing to write staged SciRetriever repository path: {resolved}. "
                "Use a scratch output outside the staged repository, or pass "
                "--allow-staged-write for an explicitly controlled copy."
            )
        return resolved
    try:
        workspace_root = find_workspace_root(repository_root)
    except RuntimeError as error:
        if not resolved.is_relative_to(repository_root):
            return resolved
        if WORKSPACE_ROOT_ENV not in os.environ:
            raise PermissionError(
                f"Refusing to write staged SciRetriever repository path: {resolved}. "
                "Use a scratch output outside the staged repository, or pass "
                "--allow-staged-write for an explicitly controlled copy."
            ) from error
        raise PermissionError(
            f"Refusing write because the SciRetriever workspace could not be verified: {error}"
        ) from error
    staged_root = (workspace_root / "literature" / "retrieval" / "SciRetriever").resolve()
    if repository_root == staged_root and resolved.is_relative_to(staged_root) and not allow_staged_write:
        raise PermissionError(
            f"Refusing to write staged SciRetriever repository path: {resolved}. "
            "Use a scratch output outside the staged repository, or pass "
            "--allow-staged-write for an explicitly controlled copy."
        )
    return resolved
