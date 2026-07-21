"""Acquisition-compatible facade over shared URL policy mechanics."""

from sciretriever.errors import AcquisitionError
from sciretriever.network.policy import NetworkPolicyError, UrlPolicy as SharedUrlPolicy


class UrlPolicy(SharedUrlPolicy):
    def validate(self, url: str, resolved_addresses: tuple[str, ...]) -> None:
        try:
            super().validate(url, resolved_addresses)
        except NetworkPolicyError as error:
            raise AcquisitionError(str(error)) from error


__all__ = ("UrlPolicy",)
