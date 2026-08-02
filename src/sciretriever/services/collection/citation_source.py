from __future__ import annotations

from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.primitives import CitationDirection
from sciretriever.model.sources import CitationDiscoveryRequest, CitationObservation

from .citation_progress import CitationProgress
from .ports import CitationSourcePort


def discover_source(
    source: CitationSourcePort,
    provider: str,
    request: CitationDiscoveryRequest,
    requested_direction: CitationDirection,
    progress: CitationProgress,
) -> tuple[CitationObservation, ...]:
    try:
        result = source.port.expand(request)
        valid_result = result.provider == provider and all(
            item.provider == provider
            and item.source_work_id == request.seed
            and item.direction.value in ("references", "cited-by")
            and (requested_direction.value == "both" or item.direction == requested_direction)
            for item in result.observations
        )
        if not valid_result:
            progress.failed(provider, _failure(provider, "provider-invalid-response", False))
            return ()
        observations = tuple(
            sorted(
                set(result.observations),
                key=lambda item: (
                    item.target_identifier.namespace,
                    item.target_identifier.value,
                    item.direction.value,
                ),
            )
        )
    except KeyboardInterrupt:
        progress.failed(provider, _failure(provider, "interrupted", True))
        raise
    except (OSError, TimeoutError):
        progress.failed(provider, _failure(provider, "provider-unavailable", True))
        return ()
    except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
        progress.failed(provider, _failure(provider, "provider-execution-failed", True))
        return ()
    if result.failure is not None:
        progress.failed(provider, result.failure)
    progress.discovered(provider, len(observations))
    return observations


def _failure(provider: str, code: str, retryable: bool) -> FailureEvidence:
    messages = {
        "provider-invalid-response": (
            f"{provider} citation response was invalid",
            "Check the citation provider response.",
        ),
        "interrupted": (
            "citation collection was interrupted",
            "Rerun citation collection to resume.",
        ),
        "provider-unavailable": (
            f"{provider} citation provider failed",
            "Retry the citation provider.",
        ),
        "provider-execution-failed": (
            f"{provider} citation provider execution failed",
            "Inspect the citation adapter and retry.",
        ),
    }
    reason, action = messages[code]
    return FailureEvidence(
        code=code,
        reason=Reason(value=reason),
        action=Action(value=action),
        retryable=retryable,
    )


__all__ = ("discover_source",)
