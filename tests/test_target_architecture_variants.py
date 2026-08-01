from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.architecture_checks import find_architecture_violations


def scan(relative: str, source: str) -> tuple[str, ...]:
    with TemporaryDirectory(prefix="sciretriever-target-variants-") as temporary:
        root = Path(temporary)
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
        return find_architecture_violations(root, frozenset())


class TargetArchitectureVariantTests(unittest.TestCase):
    def test_opaque_storage_files_reject_decoder_syntax_variants(self) -> None:
        cases = {
            "match": (
                "literature_store/opaque.py",
                "import json\nfrom typing import Annotated\n"
                "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
                "def decode(namespace, payload_json: Annotated[str, "
                "'sciretriever:opaque-extension-payload']):\n"
                "    match namespace:\n"
                "        case 'package': return json.loads(payload_json)\n",
            ),
            "renamed symbol and model decoder": (
                "literature_store/records.py",
                "from typing import Annotated\n"
                "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
                "def hydrate(data: Annotated[str, 'sciretriever:opaque-extension-payload']): "
                "return PackageModel.model_validate_json(data)\n",
            ),
            "table and alternate json decoder": (
                "literature_store/sqlite/records.py",
                "from typing import Annotated\nTABLE = 'opaque_extension_records'\n"
                "def hydrate(data: Annotated[str, 'sciretriever:opaque-extension-payload']): "
                "return orjson.loads(data)\n",
            ),
        }
        expected_suffix = (
            "literature_store must not deserialize or interpret opaque extension payloads"
        )
        for name, (relative, source) in cases.items():
            with self.subTest(name=name):
                violations = scan(relative, source)
                self.assertEqual(len(violations), 1)
                self.assertTrue(violations[0].endswith(expected_suffix))

    def test_generic_opaque_storage_without_decoder_remains_allowed(self) -> None:
        source = (
            "from typing import Annotated\n"
            "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
            "TABLE = 'opaque_extension_records'\n"
            "class Store(OpaqueExtensionRecordStorePort):\n"
            "    def put(self, payload: Annotated[str, "
            "'sciretriever:opaque-extension-payload']): return payload\n"
        )

        self.assertEqual(scan("literature_store/sqlite/opaque_records.py", source), ())

    def test_package_contract_structures_are_detected_by_fields(self) -> None:
        cases = {
            "dataclass renamed": (
                "from dataclasses import dataclass\n@dataclass\n"
                "class DeliveryRecord:\n"
                "    schema_version: str\n    payload: dict[str, str]\n"
            ),
            "pydantic renamed": (
                "from pydantic import BaseModel\nclass Snapshot(BaseModel):\n"
                "    package_id: str\n    package_sha256: str\n"
            ),
            "typed dict renamed": (
                "from typing import TypedDict\nclass SnapshotMap(TypedDict):\n"
                "    work_version_id: str\n    published_at: str\n"
            ),
            "named tuple renamed": (
                "from typing import NamedTuple\nclass SnapshotTuple(NamedTuple):\n"
                "    package_id: str\n    lineage: tuple[str, ...]\n"
            ),
        }
        for name, source in cases.items():
            with self.subTest(name=name):
                self.assertEqual(
                    scan("literature_store/schema.py", source),
                    (
                        "literature_store/schema.py: literature_store must remain "
                        "opaque to Package schemas",
                    ),
                )

    def test_benign_helpers_without_package_contract_fields_pass(self) -> None:
        source = (
            "from dataclasses import dataclass\n@dataclass\n"
            "class PackageDeliveryCounter:\n    delivered: int\n"
        )

        self.assertEqual(scan("literature_store/helpers.py", source), ())

    def test_open_modes_are_normalized_for_builtin_and_path_calls(self) -> None:
        cases = {
            "builtin keyword": "open('x', mode='wb')\n",
            "builtin constant expression": "MODE = 'w' + 'b'\nopen('x', mode=MODE)\n",
            "path keyword append": (
                "from pathlib import Path\nPath('x').open(mode='ab')\n"
            ),
        }
        for name, source in cases.items():
            with self.subTest(name=name):
                self.assertEqual(
                    scan("content/write.py", source),
                    ("content/write.py: business modules must not write artifact files",),
                )

    def test_builtin_and_path_read_modes_pass(self) -> None:
        source = (
            "from pathlib import Path\n"
            "open('x', mode='rb').read()\n"
            "Path('x').open(mode='r').read()\n"
        )

        self.assertEqual(scan("content/read.py", source), ())

    def test_oracle_alias_taint_and_boundary_policy(self) -> None:
        forbidden = (
            "from typing import Annotated\nimport json as codec\n"
            "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
            "parse = codec.loads\nhydrate = parse\n"
            "def put(raw: Annotated[str, 'sciretriever:opaque-extension-payload']):\n"
            "    first = raw\n    second = first\n    return hydrate(second)\n"
        )
        generic = (
            "from typing import Annotated\nimport json\n"
            "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
            "def put(raw: Annotated[str, 'sciretriever:opaque-extension-payload']): "
            "return raw\n"
            "def validate(config_json: str): return json.loads(config_json)\n"
        )
        missing = (
            "from sciretriever.kernel.extensions import OpaqueExtensionRecordStorePort\n"
            "class Store(OpaqueExtensionRecordStorePort): pass\n"
        )
        self.assertTrue(scan("literature_store/store.py", forbidden))
        self.assertEqual(scan("literature_store/store.py", generic), ())
        self.assertTrue(scan("literature_store/store.py", missing))

    def test_oracle_schema_aliases_and_work_view_control(self) -> None:
        decorator = (
            "from dataclasses import dataclass as record\n@record\nclass Snapshot:\n"
            "    schema_version: str\n    payload: str\n"
        )
        base = (
            "from pydantic import BaseModel as Model\nAlias = Model\nAlias2 = Alias\n"
            "class Snapshot(Alias2):\n    package_id: str\n    package_sha256: str\n"
        )
        work_view = (
            "from typing import TypedDict as Shape\n"
            "class WorkView(Shape):\n    work_id: str\n    metadata: dict[str, str]\n"
        )
        self.assertTrue(scan("literature_store/a.py", decorator))
        self.assertTrue(scan("literature_store/b.py", base))
        self.assertEqual(scan("literature_store/view.py", work_view), ())

    def test_oracle_open_aliases_annotated_modes_and_unknown_modes(self) -> None:
        cases = (
            "from typing import Final\nfrom builtins import open as file_open\n"
            "writer = file_open\nwriter2 = writer\nMODE: Final = 'wb'\n"
            "writer2('x', mode=MODE)\n",
            "from pathlib import Path as P\nQ = P\nMODE = get_mode()\nQ('x').open(MODE)\n",
        )
        for source in cases:
            self.assertTrue(scan("content/write.py", source))

    def test_document_package_table_declarations_resolve_literal_aliases(self) -> None:
        cases = (
            "from sqlalchemy import MetaData, Table\n"
            "Table('document_packages', MetaData())\n",
            "from sqlalchemy import MetaData, Table as SqlTable\n"
            "T = SqlTable\nNAME = 'document_' + 'packages'\nT(NAME, MetaData())\n",
            "NAME = 'document_packages'\nclass Row:\n    __tablename__ = NAME\n",
            "from typing import Final\nNAME: Final = 'document_packages'\n"
            "class Row:\n    __tablename__: str = NAME\n",
        )
        expected = (
            "literature_store/schema.py: literature_store must remain opaque to Package schemas",
        )
        for source in cases:
            self.assertEqual(scan("literature_store/schema.py", source), expected)

    def test_unrelated_and_dynamic_table_names_remain_allowed(self) -> None:
        cases = (
            "from sqlalchemy import MetaData, Table\nTable('works', MetaData())\n",
            "from sqlalchemy import MetaData, Table\nTable(get_table_name(), MetaData())\n",
            "class Row:\n    __tablename__ = get_table_name()\n",
        )
        for source in cases:
            self.assertEqual(scan("literature_store/schema.py", source), ())


if __name__ == "__main__":
    unittest.main()
