import tempfile
import unittest
from pathlib import Path

from scripts.harness import find_document_governance_violations, find_documentation_violations


class HarnessGovernanceTests(unittest.TestCase):
    def test_documentation_gate_detects_both_broken_link_forms(self) -> None:
        for link in ("[missing](docs/missing.md)", "[missing][guide]\n\n[guide]: docs/missing.md"):
            with self.subTest(link=link), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "docs").mkdir()
                (root / "README.md").write_text(
                    "# 中文\n\n## 功能特性\n## 工作流程\n## 快速开始\n"
                    "## 数据来源\n## 配置\n## 开发与验证\n" + link + "\n",
                    encoding="utf-8",
                )
                (root / "AGENTS.md").write_text("# Agent\n", encoding="utf-8")
                (root / "HARNESS.md").write_text("# Harness\n", encoding="utf-8")
                violations = find_documentation_violations(root)
            self.assertIn("README.md: broken local link 'docs/missing.md'", violations)

    def test_documentation_gate_detects_stale_wp6_command_surface(self) -> None:
        # Given a README that still omits the final WP6 commands
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "# 中文\n\n## 功能特性\n## 工作流程\n## 快速开始\n"
                "## 数据来源\n## 配置\n## 开发与验证\n"
                "`sciretriever search`\n",
                encoding="utf-8",
            )

            # When the documentation gate runs
            violations = find_documentation_violations(root)

        # Then the stale command surface is rejected explicitly
        self.assertIn("README.md: stale or incomplete WP6 command surface", violations)

    def test_documentation_gate_rejects_unknown_example_config_key(self) -> None:
        # Given an example TOML with one field outside the strict schema
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config.example.toml").write_text(
                "schema_version = 1\nfuture = true\n",
                encoding="utf-8",
            )

            # When the documentation gate runs
            violations = find_documentation_violations(root)

        # Then the example/schema drift is rejected without echoing a value
        self.assertIn("config.example.toml: strict parser rejected the example", violations)

    def test_documentation_gate_rejects_duplicate_wp6_release_marker(self) -> None:
        # Given two progress markers claiming the final release update
        marker = "<!-- WP6_FINAL_RELEASE_RECEIPT: TODO31_940 -->"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            progress = (
                root / "docs" / "archive" / "2026-07-literature-library"
                / "implementation-progress.md"
            )
            progress.parent.mkdir(parents=True)
            progress.write_text(f"# Progress\n{marker}\n{marker}\n", encoding="utf-8")

            # When the documentation gate runs
            violations = find_documentation_violations(root)

        # Then duplicated final-release truth is rejected
        self.assertIn(
            "docs/archive/2026-07-literature-library/implementation-progress.md: "
            "Todo 31 final release marker must appear exactly once",
            violations,
        )

    def test_document_governance_accepts_current_categories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            docs = root / "docs"
            docs.mkdir()
            (docs / "README.md").write_text("# Documentation\n", encoding="utf-8")
            for directory in (
                "guides",
                "development",
                "architecture",
                "notes",
                "proposals",
                "archive",
            ):
                (docs / directory).mkdir()
            self.assertEqual(find_document_governance_violations(root), ())

    def test_document_governance_accepts_active_proposal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "idea.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text(
                "+++\ndocument_type = \"proposal\"\nstatus = \"draft\"\n+++\n\n# Idea\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertEqual(violations, ())

    def test_document_governance_requires_completed_proposal_to_be_archived(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "implemented.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text(
                "+++\ndocument_type = \"proposal\"\nstatus = \"implemented\"\n+++\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/proposals/implemented.md: proposal status 'implemented' is not active; "
            "move the document to docs/archive",
            violations,
        )

    def test_document_governance_rejects_execution_plan_in_docs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = root / "docs" / "archive" / "execution.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\ndocument_type = \"execution-plan\"\nstatus = \"approved\"\n+++\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/archive/execution.md: execution plans belong in .omo/plans, not docs",
            violations,
        )

    def test_document_governance_rejects_retired_process_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "docs" / "planning"
            path.mkdir(parents=True)
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/planning: unexpected documentation category; "
            "use guides, development, architecture, notes, proposals, or archive",
            violations,
        )

    def test_document_governance_rejects_document_at_docs_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "docs" / "proposal.md"
            path.parent.mkdir(parents=True)
            path.write_text("# Proposal\n", encoding="utf-8")
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/proposal.md: docs root may contain only README.md; "
            "move the document into its owning category",
            violations,
        )


if __name__ == "__main__":
    unittest.main()
