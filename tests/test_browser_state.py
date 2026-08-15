from __future__ import annotations

import json
import pickle
import unittest
from dataclasses import fields
from pathlib import Path
from typing import cast

from sciretriever.acquisition.browser_state import (
    BrowserFlowDisposition,
    BrowserGroupEffect,
    BrowserRunState,
    BrowserRunStateMachine,
    BrowserStateDecision,
    decision_for_browser_state,
)

_FIXTURE = (
    Path(__file__).parent / "fixtures" / "acquisition" / "browser" / "runtime-page-states.json"
)


def _runtime_page_states() -> dict[str, dict[str, str]]:
    with _FIXTURE.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise AssertionError("Browser runtime fixture must contain an object")
    result: dict[str, dict[str, str]] = {}
    for state, raw_decision in value.items():
        if not isinstance(state, str) or not isinstance(raw_decision, dict):
            raise AssertionError("Browser runtime fixture state is invalid")
        if set(raw_decision) != {"page_signal", "flow_disposition", "group_effect"}:
            raise AssertionError("Browser runtime fixture decision is incomplete")
        decision: dict[str, str] = {}
        for key, item in raw_decision.items():
            if not isinstance(key, str) or not isinstance(item, str) or not item:
                raise AssertionError("Browser runtime fixture value is invalid")
            decision[key] = item
        result[state] = decision
    return result


class BrowserRuntimeStateTests(unittest.TestCase):
    def test_every_runtime_page_fixture_has_one_exact_decision(self) -> None:
        fixtures = _runtime_page_states()
        self.assertEqual(set(fixtures), {state.value for state in BrowserRunState})
        self.assertEqual(len(fixtures), 11)

        for state in BrowserRunState:
            with self.subTest(state=state.value):
                fixture = fixtures[state.value]
                decision = decision_for_browser_state(state)
                self.assertEqual(decision.state, state)
                self.assertEqual(decision.flow_disposition.value, fixture["flow_disposition"])
                self.assertEqual(decision.group_effect.value, fixture["group_effect"])
                self.assertTrue(fixture["page_signal"])

                self.assertEqual(
                    decision.continues_current_flow,
                    state in {BrowserRunState.OPEN, BrowserRunState.AUTHENTICATED},
                )
                self.assertEqual(
                    decision.allows_other_route,
                    state in {BrowserRunState.NOT_ENTITLED, BrowserRunState.NOT_FOUND},
                )
                self.assertEqual(
                    decision.opens_circuit,
                    state in {BrowserRunState.CHALLENGE_REQUIRED, BrowserRunState.IP_BLOCKED},
                )
                self.assertEqual(decision.is_terminal, not decision.continues_current_flow)

    def test_decision_shape_cannot_override_the_closed_policy(self) -> None:
        self.assertEqual(
            tuple(field.name for field in fields(BrowserStateDecision)),
            ("state", "flow_disposition", "group_effect"),
        )
        with self.assertRaises(ValueError):
            BrowserStateDecision(
                state=BrowserRunState.LOGIN_REQUIRED,
                flow_disposition=BrowserFlowDisposition.CONTINUE,
                group_effect=BrowserGroupEffect.NONE,
            )
        with self.assertRaises(TypeError):
            decision_for_browser_state(cast(BrowserRunState, "open"))

    def test_active_flow_reaches_one_terminal_state_idempotently(self) -> None:
        machine = BrowserRunStateMachine()
        self.assertIsNone(machine.state)
        self.assertIsNone(machine.decision)
        self.assertEqual(machine.history, ())

        self.assertTrue(machine.transition(BrowserRunState.OPEN).continues_current_flow)
        machine.transition(BrowserRunState.AUTHENTICATED)
        delivered = machine.transition(BrowserRunState.PDF_CAPTURED)
        self.assertEqual(delivered.flow_disposition, BrowserFlowDisposition.PDF_DELIVERED)
        self.assertEqual(
            machine.history,
            (
                BrowserRunState.OPEN,
                BrowserRunState.AUTHENTICATED,
                BrowserRunState.PDF_CAPTURED,
            ),
        )

        self.assertIs(machine.transition(BrowserRunState.PDF_CAPTURED), delivered)
        self.assertEqual(len(machine.history), 3)
        with self.assertRaises(RuntimeError):
            machine.transition(BrowserRunState.OPEN)

    def test_each_terminal_page_state_closes_the_flow_and_can_fail_cleanup(self) -> None:
        terminal_states = tuple(
            state
            for state in BrowserRunState
            if state not in {BrowserRunState.OPEN, BrowserRunState.AUTHENTICATED}
        )
        for terminal in terminal_states:
            with self.subTest(state=terminal.value):
                machine = BrowserRunStateMachine()
                machine.transition(BrowserRunState.OPEN)
                decision = machine.transition(terminal)
                self.assertTrue(decision.is_terminal)
                with self.assertRaises(RuntimeError):
                    machine.transition(BrowserRunState.AUTHENTICATED)
                if terminal is not BrowserRunState.RUNTIME_FAILED:
                    failed = machine.transition(BrowserRunState.RUNTIME_FAILED)
                    self.assertEqual(
                        failed.group_effect,
                        BrowserGroupEffect.RECORD_RUNTIME_FAILURE,
                    )
                    self.assertEqual(machine.history[-1], BrowserRunState.RUNTIME_FAILED)

    def test_unopened_machine_only_accepts_open_or_early_runtime_failure(self) -> None:
        for state in BrowserRunState:
            machine = BrowserRunStateMachine()
            if state in {BrowserRunState.OPEN, BrowserRunState.RUNTIME_FAILED}:
                machine.transition(state)
                self.assertEqual(machine.state, state)
            else:
                with self.assertRaises(RuntimeError):
                    machine.transition(state)

    def test_runtime_state_objects_reject_serialization(self) -> None:
        machine = BrowserRunStateMachine()
        decision = machine.transition(BrowserRunState.OPEN)
        for value in (machine, decision):
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(TypeError):
                    pickle.dumps(value)


if __name__ == "__main__":
    unittest.main()
