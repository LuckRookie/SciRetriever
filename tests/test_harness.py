import tempfile
import unittest
from pathlib import Path
import zipfile

from scripts.harness import (
    ROOT,
    clean_build_staging,
    find_architecture_violations,
    find_document_governance_violations,
    find_documentation_violations,
    find_wheel_content_violations,
)


class HarnessTests(unittest.TestCase):
    def test_repository_documentation_and_architecture_gates_pass(self) -> None:
        self.assertEqual(find_documentation_violations(ROOT), ())
        self.assertEqual(find_architecture_violations(ROOT / "src" / "sciretriever"), ())

    def test_architecture_gate_detects_cross_capability_import(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / "acquisition" / "bad.py"
            module.parent.mkdir(parents=True)
            module.write_text(
                "from sciretriever.discovery import discover\n",
                encoding="utf-8",
            )
            violations = find_architecture_violations(source)
        self.assertEqual(
            violations,
            (
                "acquisition/bad.py: acquisition must not import "
                "sciretriever.discovery",
            ),
        )

    def test_architecture_gate_resolves_relative_cross_capability_import(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / "acquisition" / "bad.py"
            module.parent.mkdir(parents=True)
            module.write_text(
                "from ..discovery import discover\n",
                encoding="utf-8",
            )
            violations = find_architecture_violations(source)
        self.assertEqual(
            violations,
            (
                "acquisition/bad.py: acquisition must not import "
                "sciretriever.discovery",
            ),
        )

    def test_architecture_gate_detects_imported_package_member(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / "core" / "bad.py"
            module.parent.mkdir(parents=True)
            module.write_text(
                "from sciretriever import discovery\n",
                encoding="utf-8",
            )
            violations = find_architecture_violations(source)
        self.assertEqual(
            violations,
            ("core/bad.py: core must not import sciretriever.discovery",),
        )

    def test_clean_build_staging_removes_deleted_module_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stale = root / "build" / "lib" / "sciretriever" / "deleted.py"
            stale.parent.mkdir(parents=True)
            stale.write_text("stale = True\n", encoding="utf-8")
            clean_build_staging(root)
            self.assertFalse((root / "build").exists())

    def test_wheel_content_gate_detects_stale_and_missing_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "src"
            package = source / "sciretriever"
            package.mkdir(parents=True)
            (package / "current.py").write_text("current = True\n", encoding="utf-8")
            wheel = root / "sciretriever.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("sciretriever/stale.py", "stale = True\n")
            self.assertEqual(
                find_wheel_content_violations(wheel, source),
                (
                    "wheel contains stale module: sciretriever/stale.py",
                    "wheel is missing source module: sciretriever/current.py",
                ),
            )

    def test_documentation_gate_detects_broken_local_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "docs").mkdir()
            (root / "README.md").write_text(
                "# 中文\n\n"
                "## 功能特性\n## 工作流程\n## 快速开始\n"
                "## 数据来源\n## 配置\n## 开发与验证\n"
                "[missing](docs/missing.md)\n",
                encoding="utf-8",
            )
            (root / "AGENTS.md").write_text("# Agent\n", encoding="utf-8")
            (root / "HARNESS.md").write_text("# Harness\n", encoding="utf-8")
            violations = find_documentation_violations(root)
        self.assertIn("README.md: broken local link 'docs/missing.md'", violations)

    def test_documentation_gate_detects_broken_reference_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "docs").mkdir()
            (root / "README.md").write_text(
                "# 中文\n\n"
                "## 功能特性\n## 工作流程\n## 快速开始\n"
                "## 数据来源\n## 配置\n## 开发与验证\n"
                "[missing][guide]\n\n[guide]: docs/missing.md\n",
                encoding="utf-8",
            )
            (root / "AGENTS.md").write_text("# Agent\n", encoding="utf-8")
            (root / "HARNESS.md").write_text("# Harness\n", encoding="utf-8")
            violations = find_documentation_violations(root)
        self.assertIn("README.md: broken local link 'docs/missing.md'", violations)

    def test_document_governance_accepts_proposal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "idea.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text(
                "+++\n"
                'document_type = "proposal"\n'
                'status = "direction-confirmed"\n'
                'created = "2026-07-22"\n'
                "+++\n\n"
                "# Idea\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertEqual(violations, ())

    def test_document_governance_accepts_approved_execution_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "idea.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text(
                "+++\n"
                'document_type = "proposal"\n'
                'status = "direction-confirmed"\n'
                'created = "2026-07-22"\n'
                "+++\n\n"
                "# Idea\n",
                encoding="utf-8",
            )
            requirement = root / "docs" / "specs" / "requirements.md"
            requirement.parent.mkdir(parents=True)
            requirement.write_text("# Requirements\n", encoding="utf-8")
            plan = root / "docs" / "planning" / "work.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\n"
                'document_type = "execution-plan"\n'
                'status = "approved"\n'
                'owner = "maintainer"\n'
                'approved_by = "project-owner"\n'
                'approved_on = "2026-07-22"\n'
                'approval_ref = "owner-confirmation:2026-07-22"\n'
                'source_proposal = "../proposals/idea.md"\n'
                'requirements = ["../specs/requirements.md"]\n'
                "+++\n\n"
                "# Work\n\n"
                "## 目标与非目标\n\n"
                "## 工作包\n\n"
                "## 验收与验证\n\n"
                "## 发布与回退\n\n"
                "## 进度引用\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertEqual(violations, ())

    def test_document_governance_requires_progress_reference_heading(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "idea.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text(
                "+++\n"
                'document_type = "proposal"\n'
                'status = "direction-confirmed"\n'
                'created = "2026-07-22"\n'
                "+++\n\n"
                "# Idea\n",
                encoding="utf-8",
            )
            requirement = root / "docs" / "specs" / "requirements.md"
            requirement.parent.mkdir(parents=True)
            requirement.write_text("# Requirements\n", encoding="utf-8")
            plan = root / "docs" / "planning" / "work.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\n"
                'document_type = "execution-plan"\n'
                'status = "approved"\n'
                'owner = "maintainer"\n'
                'approved_by = "project-owner"\n'
                'approved_on = "2026-07-22"\n'
                'approval_ref = "owner-confirmation:2026-07-22"\n'
                'source_proposal = "../proposals/idea.md"\n'
                'requirements = ["../specs/requirements.md"]\n'
                "+++\n\n"
                "# Work\n\n"
                "## 目标与非目标\n\n"
                "## 工作包\n\n"
                "## 验收与验证\n\n"
                "## 发布与回退\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/planning/work.md: execution plan missing heading: ## 进度引用",
            violations,
        )

    def test_document_governance_rejects_proposal_in_planning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = root / "docs" / "planning" / "wrong.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\n"
                'document_type = "proposal"\n'
                'status = "under-review"\n'
                'created = "2026-07-22"\n'
                "+++\n\n"
                "# Wrong\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/planning/wrong.md: docs/planning requires "
            "document_type = 'execution-plan'",
            violations,
        )
        self.assertIn(
            "docs/planning/wrong.md: unsupported execution-plan status "
            "'under-review'",
            violations,
        )

    def test_document_governance_requires_execution_approval_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = root / "docs" / "planning" / "incomplete.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\n"
                'document_type = "execution-plan"\n'
                'status = "approved"\n'
                "+++\n\n"
                "# Incomplete\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        for field_name in (
            "owner",
            "approved_by",
            "approval_ref",
            "approved_on",
            "source_proposal",
        ):
            self.assertTrue(
                any(field_name in violation for violation in violations),
                field_name,
            )
        self.assertTrue(any("requirements" in item for item in violations))

    def test_document_governance_rejects_progress_status_in_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = root / "docs" / "proposals" / "missing.md"
            proposal.parent.mkdir(parents=True)
            proposal.write_text("# Missing metadata\n", encoding="utf-8")
            plan = root / "docs" / "planning" / "blocked.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(
                "+++\n"
                'document_type = "execution-plan"\n'
                'status = "blocked"\n'
                'owner = "maintainer"\n'
                'approved_by = "project-owner"\n'
                'approved_on = "2026-07-22"\n'
                'approval_ref = "owner-confirmation:2026-07-22"\n'
                'source_proposal = "../proposals/missing.md"\n'
                'requirements = ["../specs/requirements.md"]\n'
                "+++\n\n"
                "# Blocked\n\n"
                "## 目标与非目标\n\n"
                "## 工作包\n\n"
                "## 验收与验证\n\n"
                "## 发布与回退\n\n"
                "## 进度引用\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/proposals/missing.md: missing TOML front matter",
            violations,
        )
        self.assertIn(
            "docs/planning/blocked.md: unsupported execution-plan status 'blocked'",
            violations,
        )

    def test_document_governance_rejects_malformed_and_unknown_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposals = root / "docs" / "proposals"
            proposals.mkdir(parents=True)
            (proposals / "malformed.md").write_text(
                "+++\nstatus =\n+++\n\n# Malformed\n",
                encoding="utf-8",
            )
            (proposals / "unknown.md").write_text(
                "+++\n"
                'document_type = "proposal"\n'
                'status = "draft"\n'
                'created = "2026-07-22"\n'
                'approved_by = "nobody"\n'
                "+++\n\n"
                "# Unknown\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertTrue(
            any(
                item.startswith(
                    "docs/proposals/malformed.md: invalid TOML front matter:"
                )
                for item in violations
            )
        )
        self.assertIn(
            "docs/proposals/unknown.md: unknown proposal metadata field "
            "'approved_by'",
            violations,
        )


if __name__ == "__main__":
    unittest.main()
