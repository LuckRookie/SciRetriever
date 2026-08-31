from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PyPDF2 import PdfWriter

from tests.acceptance.helpers.installed_wheel import CommandResult, InstalledWheel

_BIBTEX = b"""@article{bibtex-good,
  title={Installed BibTeX study},
  doi={10.5555/installed.bibtex},
  date={2024-08-12},
  journaltitle={Installed BibLaTeX Journal},
  langid={en},
  eprint={2408.01234},
  eprinttype={arXiv}
}
@article{bibtex-broken,
  title={Unbalanced title}
@book{bibtex-second,
  title={Installed BibTeX book},
  isbn={978-1-4028-9462-6},
  year={2023}
}
"""

_RIS = b"""TY  - JOUR
TI  - Installed RIS study
DO  - 10.5555/installed.ris
PY  - 2022
ER  -

TY  - JOUR
TI  - Missing terminator

TY  - BOOK
TI  - Installed RIS book
SN  - 978-0-306-40615-7
PY  - 2021
ER  -
"""

_CSL_JSON = b"""[
  {"title":"Installed CSL study","type":"article-journal",
   "DOI":"10.5555/installed.csl","issued":{"date-parts":[[2020]]}},
  42,
  {"title":"Installed CSL book","type":"book","ISBN":"978-0-201-53082-7",
   "issued":{"date-parts":[[2019]]}}
]"""


def _pdf_bytes() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


def _temporary_entries(prefix: str) -> frozenset[str]:
    temporary_root = Path(tempfile.gettempdir()).resolve(strict=True)
    return frozenset(path.name for path in temporary_root.iterdir() if path.name.startswith(prefix))


class InstalledExchangeAndManualPdfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def _root(self) -> Path:
        root = self.install.root
        if root is None:
            raise RuntimeError("installed wheel fixture is not active")
        return root

    def _run(
        self,
        arguments: tuple[str, ...],
        *,
        environment: dict[str, str],
        root: Path,
    ) -> CommandResult:
        return self.install.run_console(
            arguments,
            environment=environment,
            cwd=root,
            timeout=30,
        )

    def _json_result(
        self,
        arguments: tuple[str, ...],
        *,
        environment: dict[str, str],
        root: Path,
        returncode: int = 0,
    ) -> Any:
        result = self._run(arguments, environment=environment, root=root)
        self.assertEqual(result.returncode, returncode, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        return json.loads(result.stdout)

    def test_installed_console_round_trips_bibliographies_and_manual_pdf(self) -> None:
        root = self._root() / "exchange-and-manual"
        root.mkdir(mode=0o700)
        catalog = root / "catalog.sqlite3"
        artifacts = root / "artifacts"
        configuration = self.install.write_user_configuration(
            "\n".join(
                (
                    "[paths]",
                    f"catalog_path = {json.dumps(os.fspath(catalog))}",
                    f"artifact_root = {json.dumps(os.fspath(artifacts))}",
                    "",
                )
            ),
        )
        assert self.install.home is not None
        self.assertEqual(
            configuration,
            self.install.home / ".sciretriever" / "config.toml",
        )
        environment: dict[str, str] = {}

        inputs = {
            "bibtex": _BIBTEX,
            "ris": _RIS,
            "csl-json": _CSL_JSON,
        }
        import_reports: dict[str, Any] = {}
        for format_name, source_bytes in inputs.items():
            source = root / f"input.{format_name}"
            source.write_bytes(source_bytes)
            report = self._json_result(
                (
                    "import",
                    "metadata",
                    format_name,
                    os.fspath(source),
                    "--json",
                ),
                environment=environment,
                root=root,
            )
            import_reports[format_name] = report
            self.assertEqual(report["kind"], "import")
            self.assertEqual(report["format"], format_name)
            self.assertEqual(report["end"], {"kind": "finished"})
            self.assertEqual(report["input_record_count"], 3)
            records = report["records"]
            self.assertIsInstance(records, list)
            self.assertEqual(
                [record["kind"] for record in records],
                ["accepted", "rejected", "accepted"],
            )
            self.assertEqual(
                [record["record_index"] for record in records],
                [0, 1, 2],
            )
            self.assertEqual(
                [record["outcome"] for record in (records[0], records[2])],
                ["created", "created"],
            )
            self.assertEqual(report["not_processed_record_indexes"], [])
            self.assertEqual(len(report["accepted_meta_literature_ids"]), 2)

        search = self._json_result(
            ("literature", "search", "--limit", "20", "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(search["total_count"], 6)
        self.assertEqual(len(search["items"]), 6)
        literature_by_title = {
            item["literature"]["metadata"]["title"]: item["literature"]["literature_id"]
            for item in search["items"]
        }
        expected_titles = {
            "Installed BibTeX study",
            "Installed BibTeX book",
            "Installed RIS study",
            "Installed RIS book",
            "Installed CSL study",
            "Installed CSL book",
        }
        self.assertEqual(set(literature_by_title), expected_titles)
        metadata_only_details = {}
        for title, literature_id in literature_by_title.items():
            item = next(
                value
                for value in search["items"]
                if value["literature"]["literature_id"] == literature_id
            )
            self.assertEqual(item["literature"]["status"], "UNREVIEWED")
            self.assertEqual(item["missing_step"], "primary-pdf")
            detail = self._json_result(
                ("literature", "show", literature_id, "--json"),
                environment=environment,
                root=root,
            )
            metadata_only_details[title] = detail
            self.assertEqual(detail["literature"]["status"], "UNREVIEWED")
            self.assertEqual(detail["missing_step"], "primary-pdf")
            self.assertIsNone(detail["primary_pdf"])
            self.assertIsNone(detail["parser_result"])
            self.assertIsNone(detail["content"])

        biblatex_metadata = metadata_only_details["Installed BibTeX study"]["literature"][
            "metadata"
        ]
        self.assertEqual(biblatex_metadata["publication_date"], "2024-08-12")
        self.assertEqual(biblatex_metadata["publication_year"], 2024)
        self.assertEqual(biblatex_metadata["venue"], "Installed BibLaTeX Journal")
        self.assertEqual(biblatex_metadata["language"], "en")
        self.assertIn(
            {"namespace": "arxiv", "value": "2408.01234"},
            biblatex_metadata["identifiers"],
        )

        repeated_title = "Installed CSL study"
        repeated_id = literature_by_title[repeated_title]
        detail_before_repeat = metadata_only_details[repeated_title]
        self.assertEqual(len(detail_before_repeat["metadata_observations"]), 1)
        repeat_report = self._json_result(
            (
                "import",
                "metadata",
                "csl-json",
                os.fspath(root / "input.csl-json"),
                "--json",
            ),
            environment=environment,
            root=root,
        )
        repeat_records = repeat_report["records"]
        self.assertEqual(
            [record["outcome"] for record in (repeat_records[0], repeat_records[2])],
            ["matched", "matched"],
        )
        self.assertEqual(
            repeat_report["accepted_meta_literature_ids"],
            import_reports["csl-json"]["accepted_meta_literature_ids"],
        )
        detail_after_repeat = self._json_result(
            ("literature", "show", repeated_id, "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(detail_after_repeat, detail_before_repeat)
        self.assertEqual(len(detail_after_repeat["metadata_observations"]), 1)

        user_spools_before = _temporary_entries("sciretriever-user-output-")
        exported_payloads: dict[str, bytes] = {}
        for format_name in inputs:
            target = root / f"library.{format_name}"
            export_report = self._json_result(
                (
                    "export",
                    "metadata",
                    format_name,
                    os.fspath(target),
                    "--json",
                ),
                environment=environment,
                root=root,
            )
            payload = target.read_bytes()
            exported_payloads[format_name] = payload
            self.assertEqual(export_report["kind"], "export")
            self.assertEqual(export_report["format"], format_name)
            self.assertEqual(export_report["end"], {"kind": "finished"})
            self.assertEqual(len(export_report["selected_literature_ids"]), 6)
            self.assertEqual(
                export_report["published_literature_ids"],
                export_report["selected_literature_ids"],
            )
            self.assertEqual(export_report["skipped"], [])
            self.assertEqual(export_report["not_published_literature_ids"], [])
            self.assertEqual(export_report["bytes_written"], len(payload))
            self.assertTrue(payload)

            old_payload = b"caller-owned-existing-output\n"
            target.write_bytes(old_payload)
            target.chmod(0o600)
            conflict = self._json_result(
                (
                    "export",
                    "metadata",
                    format_name,
                    os.fspath(target),
                    "--json",
                ),
                environment=environment,
                root=root,
                returncode=3,
            )
            self.assertEqual(conflict["end"]["kind"], "failed")
            self.assertEqual(conflict["published_literature_ids"], [])
            self.assertEqual(target.read_bytes(), old_payload)

            overwritten = self._json_result(
                (
                    "export",
                    "metadata",
                    format_name,
                    os.fspath(target),
                    "--overwrite",
                    "--json",
                ),
                environment=environment,
                root=root,
            )
            self.assertEqual(overwritten["end"], {"kind": "finished"})
            self.assertEqual(target.read_bytes(), payload)

        self.assertTrue(exported_payloads["bibtex"].lstrip().startswith(b"@"))
        self.assertIn(b"TY  - ", exported_payloads["ris"])
        self.assertIsInstance(json.loads(exported_payloads["csl-json"]), list)
        self.assertEqual(
            sorted(
                path.name
                for path in root.iterdir()
                if path.name.startswith(".sciretriever-output-")
            ),
            [],
        )
        self.assertEqual(
            _temporary_entries("sciretriever-user-output-") - user_spools_before,
            frozenset(),
        )

        manual_id = literature_by_title["Installed BibTeX study"]
        pdf_source = root / "caller-owned.pdf"
        pdf = _pdf_bytes()
        pdf_source.write_bytes(pdf)
        pdf_source.chmod(0o640)
        source_before = pdf_source.stat()
        source_digest = hashlib.sha256(pdf).hexdigest()

        manual_report = self._json_result(
            (
                "import",
                "pdf",
                manual_id,
                os.fspath(pdf_source),
                "--json",
            ),
            environment=environment,
            root=root,
        )
        self.assertEqual(manual_report["kind"], "manual-pdf")
        self.assertEqual(manual_report["end"], {"kind": "finished"})
        self.assertEqual(manual_report["literature_id"], manual_id)
        self.assertEqual(manual_report["result"]["kind"], "accepted")
        accepted_asset = manual_report["result"]["accepted"]["asset"]
        self.assertEqual(accepted_asset["sha256"], source_digest)
        self.assertEqual(accepted_asset["size_bytes"], len(pdf))
        self.assertEqual(accepted_asset["media_type"], "application/pdf")

        source_after = pdf_source.stat()
        self.assertEqual(pdf_source.read_bytes(), pdf)
        self.assertEqual(hashlib.sha256(pdf_source.read_bytes()).hexdigest(), source_digest)
        self.assertTrue(os.path.samestat(source_before, source_after))
        self.assertEqual(source_after.st_ino, source_before.st_ino)
        self.assertEqual(stat.S_IMODE(source_after.st_mode), stat.S_IMODE(source_before.st_mode))

        manual_detail = self._json_result(
            ("literature", "show", manual_id, "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(manual_detail["literature"]["status"], "ASSET_READY")
        self.assertEqual(manual_detail["missing_step"], "parser-result")
        self.assertFalse(manual_detail["needs_manual_pdf"])
        self.assertIsNone(manual_detail["parser_result"])
        self.assertIsNone(manual_detail["content"])
        self.assertEqual(
            manual_detail["primary_pdf"]["asset"]["sha256"],
            source_digest,
        )
        self.assertEqual(
            manual_detail["primary_pdf"]["literature_asset"]["provenance"]["source_kind"],
            "user",
        )
        self.assertEqual(
            manual_detail["primary_pdf"]["literature_asset"]["provenance"]["source_name"],
            "manual-pdf",
        )
        rendered_manual = json.dumps(
            {"detail": manual_detail, "report": manual_report},
            ensure_ascii=False,
            sort_keys=True,
        )
        self.assertNotIn(os.fspath(pdf_source), rendered_manual)
        self.assertNotIn(pdf_source.name, rendered_manual)
        for database_file in root.glob(f"{catalog.name}*"):
            if database_file.is_file():
                database_bytes = database_file.read_bytes()
                self.assertNotIn(os.fsencode(os.fspath(pdf_source)), database_bytes)
                self.assertNotIn(os.fsencode(pdf_source.name), database_bytes)

        pdf_target = root / "exported.pdf"
        exported = self._json_result(
            ("export", "pdf", manual_id, os.fspath(pdf_target), "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(exported, True)
        self.assertEqual(pdf_target.read_bytes(), pdf)

        old_pdf = b"caller-owned-existing-pdf\n"
        pdf_target.write_bytes(old_pdf)
        pdf_target.chmod(0o600)
        pdf_target_before = pdf_target.stat()
        pdf_conflict = self._run(
            ("export", "pdf", manual_id, os.fspath(pdf_target), "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(pdf_conflict.returncode, 3)
        self.assertEqual(pdf_conflict.stdout, b"")
        self.assertEqual(pdf_conflict.stderr, b"output target already exists.\n")
        self.assertNotIn(os.fsencode(os.fspath(pdf_target)), pdf_conflict.stderr)
        self.assertNotIn(os.fsencode(pdf_target.name), pdf_conflict.stderr)
        self.assertNotIn(b"Traceback", pdf_conflict.stderr)
        self.assertNotIn(b"internal operation failed", pdf_conflict.stderr)
        self.assertEqual(pdf_target.read_bytes(), old_pdf)
        pdf_target_after = pdf_target.stat()
        self.assertTrue(os.path.samestat(pdf_target_before, pdf_target_after))
        self.assertEqual(
            stat.S_IMODE(pdf_target_before.st_mode),
            stat.S_IMODE(pdf_target_after.st_mode),
        )
        pdf_overwrite = self._json_result(
            (
                "export",
                "pdf",
                manual_id,
                os.fspath(pdf_target),
                "--overwrite",
                "--json",
            ),
            environment=environment,
            root=root,
        )
        self.assertEqual(pdf_overwrite, True)
        self.assertEqual(pdf_target.read_bytes(), pdf)

        second_manual = self._json_result(
            (
                "import",
                "pdf",
                manual_id,
                os.fspath(pdf_source),
                "--json",
            ),
            environment=environment,
            root=root,
        )
        self.assertEqual(second_manual["end"], {"kind": "finished"})
        self.assertEqual(second_manual["result"]["kind"], "rejected")
        self.assertEqual(
            second_manual["result"]["failure"]["code"],
            "manual-pdf-target-has-primary",
        )
        self.assertEqual(pdf_source.read_bytes(), pdf)
        self.assertTrue(os.path.samestat(source_before, pdf_source.stat()))
        self.assertEqual(pdf_source.stat().st_ino, source_before.st_ino)

        invalid_id = literature_by_title["Installed RIS study"]
        invalid_source = root / "invalid.pdf"
        invalid_bytes = b"this is not a PDF"
        invalid_source.write_bytes(invalid_bytes)
        invalid_source.chmod(0o640)
        invalid_before = invalid_source.stat()
        invalid_report = self._json_result(
            (
                "import",
                "pdf",
                invalid_id,
                os.fspath(invalid_source),
                "--json",
            ),
            environment=environment,
            root=root,
        )
        self.assertEqual(invalid_report["end"], {"kind": "finished"})
        self.assertEqual(invalid_report["result"]["kind"], "rejected")
        self.assertEqual(
            invalid_report["result"]["failure"]["code"],
            "manual-pdf-invalid",
        )
        invalid_after = invalid_source.stat()
        self.assertEqual(invalid_source.read_bytes(), invalid_bytes)
        self.assertTrue(os.path.samestat(invalid_before, invalid_after))
        self.assertEqual(invalid_after.st_ino, invalid_before.st_ino)
        self.assertEqual(
            stat.S_IMODE(invalid_after.st_mode),
            stat.S_IMODE(invalid_before.st_mode),
        )
        invalid_detail = self._json_result(
            ("literature", "show", invalid_id, "--json"),
            environment=environment,
            root=root,
        )
        self.assertEqual(invalid_detail["literature"]["status"], "UNREVIEWED")
        self.assertEqual(invalid_detail["missing_step"], "primary-pdf")
        self.assertIsNone(invalid_detail["primary_pdf"])


if __name__ == "__main__":
    unittest.main()
