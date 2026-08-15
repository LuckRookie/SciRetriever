"""Operation-local state decisions for one controlled Browser article flow.

The values in this module are deliberately independent of Browser vendor
objects, page details, URLs, selectors, and persistence models.  They give the
Acquisition coordinator one closed vocabulary for deciding whether the
current flow may continue, another route may be tried, or the provider risk
group needs a later pause/circuit update.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique
from types import MappingProxyType
from typing import Final, Mapping


@unique
class BrowserRunState(str, Enum):
    """The complete operation-local state vocabulary for one article flow."""

    OPEN = "open"
    AUTHENTICATED = "authenticated"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    CHALLENGE_REQUIRED = "challenge-required"
    NOT_ENTITLED = "not-entitled"
    RATE_LIMITED = "rate-limited"
    IP_BLOCKED = "ip-blocked"
    ACCOUNT_WARNING = "account-warning"
    NOT_FOUND = "not-found"
    PDF_CAPTURED = "pdf-captured"
    RUNTIME_FAILED = "runtime-failed"


@unique
class BrowserFlowDisposition(str, Enum):
    """What Acquisition may do after observing one Browser run state."""

    CONTINUE = "continue"
    NORMAL_MISS = "normal-miss"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"
    PDF_DELIVERED = "pdf-delivered"
    FAILURE = "failure"


@unique
class BrowserGroupEffect(str, Enum):
    """The provider-risk-group signal consumed by the later circuit policy."""

    NONE = "none"
    PAUSE = "pause"
    OPEN_CIRCUIT = "open-circuit"
    RECORD_RUNTIME_FAILURE = "record-runtime-failure"


_STATE_POLICY: Final[
    Mapping[BrowserRunState, tuple[BrowserFlowDisposition, BrowserGroupEffect]]
] = MappingProxyType(
    {
        BrowserRunState.OPEN: (
            BrowserFlowDisposition.CONTINUE,
            BrowserGroupEffect.NONE,
        ),
        BrowserRunState.AUTHENTICATED: (
            BrowserFlowDisposition.CONTINUE,
            BrowserGroupEffect.NONE,
        ),
        BrowserRunState.LOGIN_REQUIRED: (
            BrowserFlowDisposition.ACTION_REQUIRED,
            BrowserGroupEffect.PAUSE,
        ),
        BrowserRunState.MFA_REQUIRED: (
            BrowserFlowDisposition.ACTION_REQUIRED,
            BrowserGroupEffect.PAUSE,
        ),
        BrowserRunState.CHALLENGE_REQUIRED: (
            BrowserFlowDisposition.ACTION_REQUIRED,
            BrowserGroupEffect.OPEN_CIRCUIT,
        ),
        BrowserRunState.NOT_ENTITLED: (
            BrowserFlowDisposition.NORMAL_MISS,
            BrowserGroupEffect.NONE,
        ),
        BrowserRunState.RATE_LIMITED: (
            BrowserFlowDisposition.DEFERRED,
            BrowserGroupEffect.PAUSE,
        ),
        BrowserRunState.IP_BLOCKED: (
            BrowserFlowDisposition.ACTION_REQUIRED,
            BrowserGroupEffect.OPEN_CIRCUIT,
        ),
        BrowserRunState.ACCOUNT_WARNING: (
            BrowserFlowDisposition.ACTION_REQUIRED,
            BrowserGroupEffect.OPEN_CIRCUIT,
        ),
        BrowserRunState.NOT_FOUND: (
            BrowserFlowDisposition.NORMAL_MISS,
            BrowserGroupEffect.NONE,
        ),
        BrowserRunState.PDF_CAPTURED: (
            BrowserFlowDisposition.PDF_DELIVERED,
            BrowserGroupEffect.NONE,
        ),
        BrowserRunState.RUNTIME_FAILED: (
            BrowserFlowDisposition.FAILURE,
            BrowserGroupEffect.RECORD_RUNTIME_FAILURE,
        ),
    }
)

_ACTIVE_STATES: Final[frozenset[BrowserRunState]] = frozenset(
    {BrowserRunState.OPEN, BrowserRunState.AUTHENTICATED}
)
_TERMINAL_STATES: Final[frozenset[BrowserRunState]] = frozenset(
    set(BrowserRunState) - _ACTIVE_STATES
)


@dataclass(frozen=True, slots=True)
class BrowserStateDecision:
    """The unique route and group decision for one Browser state."""

    state: BrowserRunState
    flow_disposition: BrowserFlowDisposition
    group_effect: BrowserGroupEffect

    def __post_init__(self) -> None:
        if not isinstance(self.state, BrowserRunState):
            raise TypeError("state must be a BrowserRunState")
        if not isinstance(self.flow_disposition, BrowserFlowDisposition):
            raise TypeError("flow_disposition must be a BrowserFlowDisposition")
        if not isinstance(self.group_effect, BrowserGroupEffect):
            raise TypeError("group_effect must be a BrowserGroupEffect")
        if _STATE_POLICY[self.state] != (self.flow_disposition, self.group_effect):
            raise ValueError("Browser state decisions are fixed by the runtime contract")

    @property
    def continues_current_flow(self) -> bool:
        return self.flow_disposition is BrowserFlowDisposition.CONTINUE

    @property
    def allows_other_route(self) -> bool:
        return self.flow_disposition is BrowserFlowDisposition.NORMAL_MISS

    @property
    def is_terminal(self) -> bool:
        return not self.continues_current_flow

    @property
    def pauses_group(self) -> bool:
        return self.group_effect in {
            BrowserGroupEffect.PAUSE,
            BrowserGroupEffect.OPEN_CIRCUIT,
        }

    @property
    def opens_circuit(self) -> bool:
        return self.group_effect is BrowserGroupEffect.OPEN_CIRCUIT

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserStateDecision cannot be serialized")


_DECISIONS: Final[Mapping[BrowserRunState, BrowserStateDecision]] = MappingProxyType(
    {
        state: BrowserStateDecision(
            state=state,
            flow_disposition=policy[0],
            group_effect=policy[1],
        )
        for state, policy in _STATE_POLICY.items()
    }
)


def decision_for_browser_state(state: BrowserRunState) -> BrowserStateDecision:
    """Return the immutable, unique decision assigned to ``state``."""

    if not isinstance(state, BrowserRunState):
        raise TypeError("state must be a BrowserRunState")
    return _DECISIONS[state]


class BrowserRunStateMachine:
    """A bounded in-memory transition history for one Browser article flow.

    Active states may move to a terminal state.  Repeating the current state
    is idempotent, while a terminal state cannot be reopened.  A cleanup or
    runtime failure may supersede any earlier state, including a captured PDF,
    because bytes are not safely delivered until the complete Browser article
    transaction has closed.
    """

    __slots__ = ("_history", "_state")

    def __init__(self) -> None:
        self._state: BrowserRunState | None = None
        self._history: list[BrowserRunState] = []

    @property
    def state(self) -> BrowserRunState | None:
        return self._state

    @property
    def decision(self) -> BrowserStateDecision | None:
        state = self._state
        return None if state is None else decision_for_browser_state(state)

    @property
    def history(self) -> tuple[BrowserRunState, ...]:
        return tuple(self._history)

    def transition(self, state: BrowserRunState) -> BrowserStateDecision:
        if not isinstance(state, BrowserRunState):
            raise TypeError("state must be a BrowserRunState")
        current = self._state
        if current is state:
            return decision_for_browser_state(state)
        if not self._allows_transition(current, state):
            raise RuntimeError("Browser runtime state transition is invalid")
        self._state = state
        self._history.append(state)
        return decision_for_browser_state(state)

    @staticmethod
    def _allows_transition(
        current: BrowserRunState | None,
        target: BrowserRunState,
    ) -> bool:
        if current is None:
            return target in {BrowserRunState.OPEN, BrowserRunState.RUNTIME_FAILED}
        if target is BrowserRunState.RUNTIME_FAILED:
            return current is not BrowserRunState.RUNTIME_FAILED
        if current is BrowserRunState.OPEN:
            return target is BrowserRunState.AUTHENTICATED or target in _TERMINAL_STATES
        if current is BrowserRunState.AUTHENTICATED:
            return target in _TERMINAL_STATES
        return False

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserRunStateMachine cannot be serialized")


__all__ = (
    "BrowserFlowDisposition",
    "BrowserGroupEffect",
    "BrowserRunState",
    "BrowserRunStateMachine",
    "BrowserStateDecision",
    "decision_for_browser_state",
)
