from __future__ import annotations

from io import StringIO
import re
import xml.etree.ElementTree as ET
from typing import Final

from sciretriever.interoperability.model import ExportEncodingResult, RecordParseResult
from sciretriever.kernel import BibliographyFormat
from ._common import CodecInputError, decode_xml_bytes, read_bounded, record, rejected


MAX_XML_DEPTH: Final = 24
_FORBIDDEN: Final = re.compile(
    r"<!\s*(?:DOCTYPE|ENTITY)\b|\b(?:SYSTEM|PUBLIC|NDATA)\b", re.IGNORECASE,
)
_SUPPORTED_NAMESPACES: Final = frozenset(("", "urn:endnote"))


def _name(element: ET.Element) -> tuple[str, str]:
    if element.tag.startswith("{"):
        namespace, local = element.tag[1:].split("}", 1)
        return namespace, local
    return "", element.tag


def _children(element: ET.Element, namespace: str, local: str) -> tuple[ET.Element, ...]:
    return tuple(child for child in element if _name(child) == (namespace, local))


def _path(element: ET.Element, namespace: str, *parts: str) -> tuple[ET.Element, ...]:
    current = (element,)
    for part in parts:
        current = tuple(child for parent in current for child in _children(parent, namespace, part))
    return current


def _texts(element: ET.Element, namespace: str, *parts: str) -> tuple[str, ...]:
    return tuple(value for item in _path(element, namespace, *parts) if (value := "".join(item.itertext()).strip()))


def _one(element: ET.Element, namespace: str, *parts: str) -> str | None:
    values = _texts(element, namespace, *parts)
    return values[0] if values else None


class EndnoteXmlCodec:
    format = BibliographyFormat.ENDNOTE_XML

    def read(self, stream) -> tuple[RecordParseResult, ...]:
        try:
            payload = read_bounded(stream)
            text = decode_xml_bytes(payload)
            if _FORBIDDEN.search(text):
                raise CodecInputError("unsafe-xml", "DTD, entity, and external references are forbidden")
            depth = 0
            for event, _element in ET.iterparse(StringIO(text), events=("start", "end")):
                depth += 1 if event == "start" else -1
                if depth > MAX_XML_DEPTH:
                    raise CodecInputError("xml-too-deep", "EndNote XML exceeds the depth limit")
            root = ET.fromstring(text)
            namespace, root_name = _name(root)
            if root_name != "xml" or namespace not in _SUPPORTED_NAMESPACES:
                raise CodecInputError("unsupported-namespace", "EndNote XML root namespace is unsupported")
            if any(_name(element)[0] != namespace for element in root.iter()):
                raise CodecInputError("mixed-namespace", "EndNote XML must use one validated namespace")
        except (CodecInputError, ET.ParseError) as error:
            return (rejected(0, "unsafe-or-malformed-xml", str(error)),)
        results: list[RecordParseResult] = []
        records = tuple(
            record_element
            for records_element in _children(root, namespace, "records")
            for record_element in _children(records_element, namespace, "record")
        )
        for ordinal, item in enumerate(records):
            try:
                year, month = _one(item, namespace, "dates", "year"), _one(item, namespace, "dates", "month")
                accession = _one(item, namespace, "accession-num")
                serial = _one(item, namespace, "isbn")
                ids = (("doi", _one(item, namespace, "electronic-resource-num")),
                       ("pmid", accession), ("issn", serial))
                result = record(
                    title=_one(item, namespace, "titles", "title"),
                    authors=_texts(item, namespace, "contributors", "authors", "author"),
                    institutions=_texts(item, namespace, "contributors", "secondary-authors", "author"),
                    identifier_values=tuple((key, value) for key, value in ids if value),
                    abstract=_one(item, namespace, "abstract"), keywords=_texts(item, namespace, "keywords", "keyword"),
                    tags=tuple(value for name in ("custom1", "custom2", "custom3") if (value := _one(item, namespace, name))),
                    references=_texts(item, namespace, "references", "reference"),
                    year=int(year) if year and year.isdigit() else None,
                    month=int(month) if month and month.isdigit() else None,
                    venue=_one(item, namespace, "titles", "secondary-title"), volume=_one(item, namespace, "volume"),
                    issue=_one(item, namespace, "number"), pages=_one(item, namespace, "pages"),
                    item_type="article" if _children(item, namespace, "ref-type") else None,
                    language=_one(item, namespace, "language"),
                )
                results.append(RecordParseResult(ordinal, result, None))
            except (CodecInputError, KeyError, TypeError, ValueError) as error:
                results.append(rejected(ordinal, "malformed-record", str(error)))
        return tuple(results) or (rejected(0, "empty-input", "input contains no EndNote records"),)

    def write(self, records, stream) -> ExportEncodingResult:
        raise NotImplementedError
