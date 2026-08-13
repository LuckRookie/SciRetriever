"""Explicitly assembled Entry API with a closed user-facing method surface."""

from __future__ import annotations

from collections.abc import Callable as _Callable
from contextlib import AbstractContextManager as _AbstractContextManager
from os import PathLike as _PathLike
from typing import BinaryIO as _BinaryIO
from typing import TypeVar as _TypeVar

from sciretriever.literature.api import (
    LiteratureArtifactReference as _LiteratureArtifactReference,
)
from sciretriever.model.discovery import (
    CitationDiscoveryInput as _CitationDiscoveryInput,
)
from sciretriever.model.discovery import (
    TopicDiscoveryInput as _TopicDiscoveryInput,
)
from sciretriever.model.execution import (
    BatchRequest as _BatchRequest,
)
from sciretriever.model.execution import (
    DiscoveryRunSelector as _DiscoveryRunSelector,
)
from sciretriever.model.execution import (
    LiteratureSelector as _LiteratureSelector,
)
from sciretriever.model.execution import (
    MetaLiteratureSelector as _MetaLiteratureSelector,
)
from sciretriever.model.execution import (
    QuerySelector as _QuerySelector,
)
from sciretriever.model.library import (
    LibrarySearchPage as _LibrarySearchPage,
)
from sciretriever.model.library import (
    LibrarySearchRequest as _LibrarySearchRequest,
)
from sciretriever.model.library import (
    LiteratureDetail as _LiteratureDetail,
)
from sciretriever.model.library import (
    LiteratureReferencePage as _LiteratureReferencePage,
)
from sciretriever.model.library import (
    LiteratureReferenceRequest as _LiteratureReferenceRequest,
)
from sciretriever.model.library import (
    ReferenceDetail as _ReferenceDetail,
)
from sciretriever.model.primitives import (
    LiteratureId as _LiteratureId,
)
from sciretriever.model.primitives import (
    ReferenceId as _ReferenceId,
)
from sciretriever.model.report import (
    BibliographyFormat as _BibliographyFormat,
)
from sciretriever.model.report import (
    DatabaseCompletionReport as _DatabaseCompletionReport,
)
from sciretriever.model.report import (
    DiscoveryReport as _DiscoveryReport,
)
from sciretriever.model.report import (
    ExportReport as _ExportReport,
)
from sciretriever.model.report import (
    ImportReport as _ImportReport,
)
from sciretriever.model.report import (
    ManualPdfReport as _ManualPdfReport,
)

_UserTarget = str | _PathLike[str]
_BibliographyExportScope = (
    _DiscoveryRunSelector | _QuerySelector | _MetaLiteratureSelector | _LiteratureSelector | None
)
_DiscoverTopicOperation = _Callable[[_TopicDiscoveryInput], _DiscoveryReport]
_DiscoverCitationsOperation = _Callable[[_CitationDiscoveryInput], _DiscoveryReport]
_CompleteDatabaseOperation = _Callable[[_BatchRequest], _DatabaseCompletionReport]
_AdmitManualPdfOperation = _Callable[[_LiteratureId, _BinaryIO], _ManualPdfReport]
_SearchLiteratureOperation = _Callable[[_LibrarySearchRequest], _LibrarySearchPage]
_GetLiteratureDetailOperation = _Callable[[_LiteratureId], _LiteratureDetail]
_ListLiteratureReferencesOperation = _Callable[
    [_LiteratureReferenceRequest],
    _LiteratureReferencePage,
]
_GetReferenceDetailOperation = _Callable[[_ReferenceId], _ReferenceDetail]
_OpenArtifactOperation = _Callable[
    [_LiteratureArtifactReference],
    _AbstractContextManager[_BinaryIO],
]
_ExportArtifactOperation = _Callable[
    [_LiteratureArtifactReference, _UserTarget, bool],
    None,
]
_ImportBibliographyOperation = _Callable[[_BibliographyFormat, _BinaryIO], _ImportReport]
_ExportBibliographyOperation = _Callable[
    [_BibliographyFormat, _BibliographyExportScope, _UserTarget, bool],
    _ExportReport,
]
_OperationT = _TypeVar("_OperationT")


def _checked_operation(operation: _OperationT, *, field_name: str) -> _OperationT:
    if not callable(operation):
        raise TypeError(f"{field_name} must be callable")
    return operation


class EntryApi:
    """The twelve Entry use cases assembled once by the application Bootstrap."""

    __slots__ = (
        "_discover_topic_operation",
        "_discover_citations_operation",
        "_complete_database_operation",
        "_admit_manual_pdf_operation",
        "_search_literature_operation",
        "_get_literature_detail_operation",
        "_list_literature_references_operation",
        "_get_reference_detail_operation",
        "_open_artifact_operation",
        "_export_artifact_operation",
        "_import_bibliography_operation",
        "_export_bibliography_operation",
    )

    def __init__(
        self,
        *,
        discover_topic_operation: _DiscoverTopicOperation,
        discover_citations_operation: _DiscoverCitationsOperation,
        complete_database_operation: _CompleteDatabaseOperation,
        admit_manual_pdf_operation: _AdmitManualPdfOperation,
        search_literature_operation: _SearchLiteratureOperation,
        get_literature_detail_operation: _GetLiteratureDetailOperation,
        list_literature_references_operation: _ListLiteratureReferencesOperation,
        get_reference_detail_operation: _GetReferenceDetailOperation,
        open_artifact_operation: _OpenArtifactOperation,
        export_artifact_operation: _ExportArtifactOperation,
        import_bibliography_operation: _ImportBibliographyOperation,
        export_bibliography_operation: _ExportBibliographyOperation,
    ) -> None:
        self._discover_topic_operation = _checked_operation(
            discover_topic_operation,
            field_name="discover_topic_operation",
        )
        self._discover_citations_operation = _checked_operation(
            discover_citations_operation,
            field_name="discover_citations_operation",
        )
        self._complete_database_operation = _checked_operation(
            complete_database_operation,
            field_name="complete_database_operation",
        )
        self._admit_manual_pdf_operation = _checked_operation(
            admit_manual_pdf_operation,
            field_name="admit_manual_pdf_operation",
        )
        self._search_literature_operation = _checked_operation(
            search_literature_operation,
            field_name="search_literature_operation",
        )
        self._get_literature_detail_operation = _checked_operation(
            get_literature_detail_operation,
            field_name="get_literature_detail_operation",
        )
        self._list_literature_references_operation = _checked_operation(
            list_literature_references_operation,
            field_name="list_literature_references_operation",
        )
        self._get_reference_detail_operation = _checked_operation(
            get_reference_detail_operation,
            field_name="get_reference_detail_operation",
        )
        self._open_artifact_operation = _checked_operation(
            open_artifact_operation,
            field_name="open_artifact_operation",
        )
        self._export_artifact_operation = _checked_operation(
            export_artifact_operation,
            field_name="export_artifact_operation",
        )
        self._import_bibliography_operation = _checked_operation(
            import_bibliography_operation,
            field_name="import_bibliography_operation",
        )
        self._export_bibliography_operation = _checked_operation(
            export_bibliography_operation,
            field_name="export_bibliography_operation",
        )

    def discover_topic(self, request: _TopicDiscoveryInput) -> _DiscoveryReport:
        return self._discover_topic_operation(request)

    def discover_citations(self, request: _CitationDiscoveryInput) -> _DiscoveryReport:
        return self._discover_citations_operation(request)

    def complete_database(self, request: _BatchRequest) -> _DatabaseCompletionReport:
        return self._complete_database_operation(request)

    def admit_manual_pdf(
        self,
        literature_id: _LiteratureId,
        source: _BinaryIO,
    ) -> _ManualPdfReport:
        return self._admit_manual_pdf_operation(literature_id, source)

    def search_literature(self, request: _LibrarySearchRequest) -> _LibrarySearchPage:
        return self._search_literature_operation(request)

    def get_literature_detail(self, literature_id: _LiteratureId) -> _LiteratureDetail:
        return self._get_literature_detail_operation(literature_id)

    def list_literature_references(
        self,
        request: _LiteratureReferenceRequest,
    ) -> _LiteratureReferencePage:
        return self._list_literature_references_operation(request)

    def get_reference_detail(self, reference_id: _ReferenceId) -> _ReferenceDetail:
        return self._get_reference_detail_operation(reference_id)

    def open_artifact(
        self,
        reference: _LiteratureArtifactReference,
    ) -> _AbstractContextManager[_BinaryIO]:
        return self._open_artifact_operation(reference)

    def export_artifact(
        self,
        reference: _LiteratureArtifactReference,
        target: _UserTarget,
        *,
        overwrite: bool = False,
    ) -> None:
        self._export_artifact_operation(reference, target, overwrite)

    def import_bibliography(
        self,
        format: _BibliographyFormat,
        source: _BinaryIO,
    ) -> _ImportReport:
        return self._import_bibliography_operation(format, source)

    def export_bibliography(
        self,
        format: _BibliographyFormat,
        selector: _BibliographyExportScope,
        target: _UserTarget,
        *,
        overwrite: bool = False,
    ) -> _ExportReport:
        return self._export_bibliography_operation(format, selector, target, overwrite)


__all__ = ("EntryApi",)
