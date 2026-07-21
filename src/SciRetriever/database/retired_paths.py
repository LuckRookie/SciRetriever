from pathlib import Path

from SciRetriever.workspace_paths import (
    find_repository_root,
    find_workspace_root,
    find_workspace_root_for_target,
)


RETIRED_DATABASE_PATHS = (
    "literature/retrieval/SciRetriever/all.db",
    "literature/retrieval/SciRetriever/all_bak.db",
    "literature/retrieval/SciRetriever/CR_energetic_materials.db",
    "literature/retrieval/SciRetriever/CR_energetic_materials_synthesis.db",
    "literature/retrieval/SciRetriever/CR_title_cyclo-N5.db",
    "literature/retrieval/SciRetriever/GS.db",
    "literature/retrieval/SciRetriever/work/old_database/crossref.db",
    "literature/retrieval/SciRetriever/work/old_database/Organic_synthesis.db",
    "literature/retrieval/SciRetriever/work/old_database/paper.db",
)


def retired_database_paths(start: Path | None = None) -> frozenset[Path]:
    """Return retired paths anchored to this installed SciRetriever repository."""
    try:
        repository = find_repository_root(Path(__file__))
    except RuntimeError:
        try:
            workspace = find_workspace_root(start)
        except RuntimeError:
            # A wheel outside a configured workspace has no active retired-path anchor.
            return frozenset()
    else:
        workspace = find_workspace_root(repository)
    return frozenset((workspace / relative).resolve() for relative in RETIRED_DATABASE_PATHS)


def reject_retired_database_creation(path: Path, start: Path | None = None) -> None:
    """Refuse creation through direct, relative, or symlink-alias retired paths."""
    resolved = path.expanduser().resolve()
    protected = set(retired_database_paths(start))
    target_workspace = find_workspace_root_for_target(resolved)
    if target_workspace is not None:
        protected.update((target_workspace / relative).resolve() for relative in RETIRED_DATABASE_PATHS)
    if resolved in protected:
        raise PermissionError(f"Refusing to recreate retired database path: {resolved}")
