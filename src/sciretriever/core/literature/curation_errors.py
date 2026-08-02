class CurationPlanError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason
