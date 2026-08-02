from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import CollectionId


class QueryValueError(ValueError):
    pass


def _nonblank(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise QueryValueError("text must be nonblank")
    return value


def _unique(values: tuple[str, ...]) -> tuple[str, ...]:
    if len(values) != len(set(values)):
        raise QueryValueError("repeated filter values must be unique")
    if any(not value.strip() for value in values):
        raise QueryValueError("filter values must be nonblank")
    return values


Text = Annotated[str | None, AfterValidator(_nonblank)]
Texts = Annotated[tuple[str, ...], AfterValidator(_unique)]
CollectionMode = Literal["topic", "citation"]
DiscoveryRelation = Literal["member", "seed", "reference", "cited-by"]
State = Literal["unreviewed", "asset-ready", "light-text-ready", "completed"]
MissingStep = Literal["primary-pdf", "light-document", "analysis", "completion"]


class QueryFilterV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    query: Text = None
    identifiers: tuple[Identifier, ...] = ()
    title: Text = None
    authors: Texts = ()
    venues: Texts = ()
    document_types: Texts = ()
    languages: Texts = ()
    collection_ids: tuple[str, ...] = ()
    collection_modes: tuple[CollectionMode, ...] = ()
    discovery_relations: tuple[DiscoveryRelation, ...] = ()
    states: tuple[State, ...] = ()
    missing_steps: tuple[MissingStep, ...] = ()
    has_current_failure: bool | None = None
    year_from: Annotated[int | None, Field(ge=0, le=9999)] = None
    year_to: Annotated[int | None, Field(ge=0, le=9999)] = None
    asset_available: bool | None = None
    light_document_available: bool | None = None
    analysis_available: bool | None = None
    extension_namespaces: Texts = ()

    @model_validator(mode="after")
    def valid_combinations(self) -> QueryFilterV1:
        collections = tuple(str(CollectionId(value)) for value in self.collection_ids)
        if len(collections) != len(set(collections)):
            raise QueryValueError("collection identifiers must be unique")
        groups = (
            self.identifiers,
            self.collection_modes,
            self.discovery_relations,
            self.states,
            self.missing_steps,
        )
        if any(len(values) != len(set(values)) for values in groups):
            raise QueryValueError("repeated filter values must be unique")
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise QueryValueError("year range must be ordered")
        return self


__all__ = ("QueryFilterV1",)
