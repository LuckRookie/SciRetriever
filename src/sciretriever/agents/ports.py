"""Provider-neutral Agents execution Port."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .requests import AgentRequest, AgentResult


@runtime_checkable
class AgentPort(Protocol):
    @property
    def provider_name(self) -> str: ...

    def complete(self, request: AgentRequest) -> AgentResult: ...


__all__ = ("AgentPort", "AgentResult")
