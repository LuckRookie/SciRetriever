import tempfile
import unittest
from pathlib import Path

from scripts.harness import (
    find_document_governance_violations,
    find_documentation_violations,
)


def proposal(root: Path) -> None:
    path = root / "docs" / "proposals" / "idea.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "+++\ndocument_type = \"proposal\"\nstatus = \"direction-confirmed\"\n"
        "created = \"2026-07-22\"\n+++\n\n# Idea\n",
        encoding="utf-8",
    )


def requirement(root: Path) -> None:
    path = root / "docs" / "specs" / "requirements.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Requirements\n", encoding="utf-8")


def plan_text(status: str = "approved", *, progress: bool = True) -> str:
    final_heading = "\n## 进度引用\n" if progress else ""
    return (
        "+++\ndocument_type = \"execution-plan\"\n"
        f"status = \"{status}\"\nowner = \"maintainer\"\n"
        "approved_by = \"project-owner\"\napproved_on = \"2026-07-22\"\n"
        "approval_ref = \"owner-confirmation:2026-07-22\"\n"
        "source_proposal = \"../proposals/idea.md\"\n"
        "requirements = [\"../specs/requirements.md\"]\n+++\n\n# Work\n\n"
        "## 目标与非目标\n\n## 工作包\n\n## 验收与验证\n\n## 发布与回退\n"
        f"{final_heading}"
    )


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

    def test_document_governance_accepts_proposal_and_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal(root)
            self.assertEqual(find_document_governance_violations(root), ())
            requirement(root)
            plan = root / "docs" / "planning" / "work.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(plan_text(), encoding="utf-8")
            self.assertEqual(find_document_governance_violations(root), ())

    def test_document_governance_requires_progress_heading(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal(root)
            requirement(root)
            plan = root / "docs" / "planning" / "work.md"
            plan.parent.mkdir(parents=True)
            plan.write_text(plan_text(progress=False), encoding="utf-8")
            violations = find_document_governance_violations(root)
        self.assertIn(
            "docs/planning/work.md: execution plan missing heading: ## 进度引用",
            violations,
        )

    def test_document_governance_rejects_wrong_type_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "docs" / "planning" / "wrong.md"
            path.parent.mkdir(parents=True)
            path.write_text(
                "+++\ndocument_type = \"proposal\"\nstatus = \"under-review\"\n"
                "created = \"2026-07-22\"\n+++\n\n# Wrong\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertIn("docs/planning/wrong.md: docs/planning requires document_type = 'execution-plan'", violations)
        self.assertIn("docs/planning/wrong.md: unsupported execution-plan status 'under-review'", violations)

    def test_document_governance_requires_approval_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "docs" / "planning" / "incomplete.md"
            path.parent.mkdir(parents=True)
            path.write_text(
                "+++\ndocument_type = \"execution-plan\"\nstatus = \"approved\"\n+++\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        for field in ("owner", "approved_by", "approval_ref", "approved_on", "source_proposal", "requirements"):
            self.assertTrue(any(field in item for item in violations), field)

    def test_document_governance_rejects_blocked_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal(root)
            requirement(root)
            path = root / "docs" / "planning" / "blocked.md"
            path.parent.mkdir(parents=True)
            path.write_text(plan_text("blocked"), encoding="utf-8")
            violations = find_document_governance_violations(root)
        self.assertIn("docs/planning/blocked.md: unsupported execution-plan status 'blocked'", violations)

    def test_document_governance_rejects_malformed_and_unknown_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposals = root / "docs" / "proposals"
            proposals.mkdir(parents=True)
            (proposals / "malformed.md").write_text("+++\nstatus =\n+++\n", encoding="utf-8")
            (proposals / "unknown.md").write_text(
                "+++\ndocument_type = \"proposal\"\nstatus = \"draft\"\n"
                "created = \"2026-07-22\"\napproved_by = \"nobody\"\n+++\n",
                encoding="utf-8",
            )
            violations = find_document_governance_violations(root)
        self.assertTrue(any(item.startswith(
            "docs/proposals/malformed.md: invalid TOML front matter:"
        ) for item in violations))
        self.assertIn(
            "docs/proposals/unknown.md: unknown proposal metadata field 'approved_by'",
            violations,
        )


if __name__ == "__main__":
    unittest.main()
