from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from typing import cast

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from sciretriever.network.browser_control import BrowserObservationUnavailable
from sciretriever.network.playwright import (
    PlaywrightRuntimeError,
    _ArticleContext,
    _Context,
    _Page,
)


class _InlineEngine:
    def call(self, operation: Callable[[], object]) -> object:
        return operation()


class _ControlContext:
    def __init__(self) -> None:
        self.engine = _InlineEngine()
        self.forgotten: list[object] = []

    def forget_page(self, page: object) -> None:
        self.forgotten.append(page)


class _ControlFrameElement:
    def __init__(self, bounds: dict[str, float]) -> None:
        self._bounds = bounds

    def bounding_box(self) -> dict[str, float]:
        return dict(self._bounds)


class _ControlLocator:
    def __init__(
        self,
        marker: int,
        *,
        role: str,
        name: str,
        visible: bool = True,
        enabled: bool = True,
    ) -> None:
        self.marker = marker
        self.role = role
        self.name = name
        self.visible = visible
        self.enabled = enabled
        self.actions: list[tuple[str, object]] = []

    def evaluate(self, _script: str, argument: object) -> object:
        if type(argument) is str:
            self.actions.append(("marker-read", argument))
            return self.marker
        if isinstance(argument, dict):
            self.actions.append(("identity-check", tuple(sorted(argument))))
            return {
                "marker": self.marker,
                "role": self.role,
                "name": self.name,
                "visible": self.visible,
                "enabled": self.enabled,
            }
        raise AssertionError("unexpected locator evaluation argument")

    def click(self, *, timeout: int, no_wait_after: bool) -> None:
        self.actions.append(("click", (timeout, no_wait_after)))


class _ControlLocatorCollection:
    def __init__(self, locators: tuple[_ControlLocator, ...]) -> None:
        self._locators = locators

    def all(self) -> list[_ControlLocator]:
        return list(self._locators)


class _ControlFrame:
    def __init__(
        self,
        *,
        url: str,
        scan: dict[str, object],
        locators: tuple[_ControlLocator, ...],
        parent_frame: _ControlFrame | None = None,
        frame_bounds: dict[str, float] | None = None,
    ) -> None:
        self.url = url
        self.parent_frame = parent_frame
        self._scan = scan
        self._locators = locators
        self._frame_element = None if frame_bounds is None else _ControlFrameElement(frame_bounds)
        self.selectors: list[str] = []
        self.evaluate_error: BaseException | None = None

    def frame_element(self) -> _ControlFrameElement | None:
        return self._frame_element

    def evaluate(self, _script: str, arguments: object) -> dict[str, object]:
        if self.evaluate_error is not None:
            raise self.evaluate_error
        if not isinstance(arguments, dict):
            raise AssertionError("unexpected frame evaluation argument")
        seed = arguments.get("seed")
        expected_selector = arguments.get("selector")
        if type(seed) is not int or type(expected_selector) is not str:
            raise AssertionError("invalid control scan arguments")
        result = dict(self._scan)
        configured_next = result.get("next")
        if type(configured_next) is not int:
            raise AssertionError("fixture scan requires an integer next key")
        result["next"] = max(seed, configured_next)
        return result

    def locator(self, selector: str) -> _ControlLocatorCollection:
        self.selectors.append(selector)
        return _ControlLocatorCollection(self._locators)


class _ControlMouse:
    def __init__(self) -> None:
        self.actions: list[tuple[str, object]] = []

    def move(self, x: float, y: float) -> None:
        self.actions.append(("move", (x, y)))

    def click(self, x: float, y: float) -> None:
        self.actions.append(("click", (x, y)))

    def wheel(self, delta_x: int, delta_y: int) -> None:
        self.actions.append(("wheel", (delta_x, delta_y)))


class _ControlRawPage:
    def __init__(self, main_frame: _ControlFrame, child_frame: _ControlFrame) -> None:
        self.url = "https://publisher.sciretriever.test/article?session=fixture"
        self.viewport_size = {"width": 1200, "height": 800}
        self.main_frame = main_frame
        self.frames = [main_frame, child_frame]
        self.mouse = _ControlMouse()
        self.screenshot_calls: list[dict[str, object]] = []
        self.go_back_calls: list[tuple[int, str]] = []
        self.wait_calls: list[tuple[str, str, int]] = []
        self.wait_timeout = False
        self.wait_error: BaseException | None = None
        self.fingerprint = "initial-fingerprint"
        self.timeout_calls: list[int] = []
        self.close_calls = 0
        self.is_closed = False

    def screenshot(
        self,
        *,
        type: str,
        quality: int,
        animations: str,
        timeout: int,
        full_page: bool,
    ) -> bytes:
        self.screenshot_calls.append(
            {
                "type": type,
                "quality": quality,
                "animations": animations,
                "timeout": timeout,
                "full_page": full_page,
            }
        )
        return b"fixture-jpeg-bytes"

    def evaluate(self, _script: str) -> str:
        return self.fingerprint

    def go_back(self, *, timeout: int, wait_until: str) -> None:
        self.go_back_calls.append((timeout, wait_until))
        self.url = "https://publisher.sciretriever.test/previous?session=fixture"

    def wait_for_function(
        self,
        condition: str,
        *,
        arg: str,
        timeout: int,
    ) -> None:
        self.wait_calls.append((condition, arg, timeout))
        if self.wait_error is not None:
            raise self.wait_error
        if self.wait_timeout:
            raise PlaywrightTimeoutError("fixture timeout")

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.timeout_calls.append(milliseconds)

    def close(self) -> None:
        self.close_calls += 1


class PlaywrightControlAdapterTests(unittest.TestCase):
    def _page(
        self,
    ) -> tuple[
        _Page,
        _ControlRawPage,
        _ControlContext,
        _ControlLocator,
        _ControlLocator,
        _ControlLocator,
    ]:
        button = _ControlLocator(
            1_000_002,
            role="button",
            name="Continue",
        )
        viewer = _ControlLocator(
            1_000_003,
            role="document",
            name="Article PDF",
        )
        child_link = _ControlLocator(
            1_000_004,
            role="link",
            name="More details",
        )
        main = _ControlFrame(
            url="https://publisher.sciretriever.test/article?ticket=private",
            scan={
                "title": "Main article",
                "scrollX": 2,
                "scrollY": 4,
                "maximumX": 10,
                "maximumY": 900,
                "surfaces": [
                    {
                        "key": 1_000_000,
                        "parent": None,
                        "kind": "shadow",
                        "x": 20,
                        "y": 30,
                        "width": 500,
                        "height": 500,
                    },
                    {
                        "key": 1_000_001,
                        "parent": 1_000_000,
                        "kind": "viewer",
                        "x": 40,
                        "y": 80,
                        "width": 300,
                        "height": 200,
                    },
                ],
                "elements": [
                    {
                        "key": 1_000_002,
                        "surface": 1_000_000,
                        "role": "button",
                        "name": "Continue",
                        "visible": True,
                        "enabled": True,
                        "x": 60,
                        "y": 100,
                        "width": 120,
                        "height": 40,
                    },
                    {
                        "key": 1_000_003,
                        "surface": 1_000_001,
                        "role": "document",
                        "name": "Article PDF",
                        "visible": True,
                        "enabled": True,
                        "x": 40,
                        "y": 80,
                        "width": 300,
                        "height": 200,
                    },
                ],
                "next": 1_000_004,
            },
            locators=(button, viewer),
        )
        child = _ControlFrame(
            url="https://publisher.sciretriever.test/embedded/article?ticket=private",
            parent_frame=main,
            frame_bounds={"x": 600, "y": 100, "width": 300, "height": 200},
            scan={
                "title": "Embedded article tools",
                "scrollX": 0,
                "scrollY": 0,
                "maximumX": 0,
                "maximumY": 200,
                "surfaces": [],
                "elements": [
                    {
                        "key": 1_000_004,
                        "surface": None,
                        "role": "link",
                        "name": "More details",
                        "visible": True,
                        "enabled": True,
                        "x": 10,
                        "y": 20,
                        "width": 80,
                        "height": 30,
                    }
                ],
                "next": 1_000_005,
            },
            locators=(child_link,),
        )
        raw = _ControlRawPage(main, child)
        context = _ControlContext()
        article = cast(_ArticleContext, object())
        page = _Page(cast(_Context, context), article, raw)
        return page, raw, context, button, viewer, child_link

    def test_snapshot_converts_frame_shadow_viewer_and_private_locators(self) -> None:
        page, raw, _context, _button, _viewer, _child_link = self._page()

        without_screenshot = page.control_snapshot(
            timeout=321,
            include_screenshot=False,
        )

        self.assertIsNone(without_screenshot["screenshot"])
        self.assertIsNone(without_screenshot["screenshot_media_type"])
        self.assertEqual(raw.screenshot_calls, [])
        surfaces = cast(tuple[tuple[object, ...], ...], without_screenshot["surfaces"])
        self.assertEqual([surface[0] for surface in surfaces], [0, 1_000_000, 1_000_001, 100_002])
        self.assertEqual([surface[1] for surface in surfaces], [None, 0, 1_000_000, 0])
        self.assertEqual(
            [surface[2] for surface in surfaces],
            ["page", "shadow", "viewer", "frame"],
        )
        self.assertEqual(
            [surface[3] for surface in surfaces],
            [
                "https://publisher.sciretriever.test/article",
                "https://publisher.sciretriever.test/article",
                "https://publisher.sciretriever.test/article",
                "https://publisher.sciretriever.test/embedded/article",
            ],
        )
        elements = cast(tuple[tuple[object, ...], ...], without_screenshot["elements"])
        self.assertEqual([element[0] for element in elements], [1_000_002, 1_000_003, 1_000_004])
        self.assertEqual([element[1] for element in elements], [1_000_000, 1_000_001, 100_002])
        self.assertEqual(elements[-1][6:10], (610.0, 120.0, 80.0, 30.0))
        json.dumps(without_screenshot)
        self.assertNotIn("_ControlLocator", repr(without_screenshot))

        with_screenshot = page.control_snapshot(timeout=654, include_screenshot=True)

        self.assertEqual(with_screenshot["screenshot"], b"fixture-jpeg-bytes")
        self.assertEqual(with_screenshot["screenshot_media_type"], "image/jpeg")
        self.assertEqual(
            raw.screenshot_calls,
            [
                {
                    "type": "jpeg",
                    "quality": 70,
                    "animations": "disabled",
                    "timeout": 654,
                    "full_page": False,
                }
            ],
        )

    def test_actions_revalidate_identity_and_use_the_bound_page(self) -> None:
        page, raw, _context, button, _viewer, _child_link = self._page()
        page.control_snapshot(timeout=300, include_screenshot=False)

        self.assertTrue(
            page.control_click_element(
                1_000_002,
                expected_role="button",
                expected_name="Continue",
                expected_enabled=True,
                expected_surface_key=1_000_000,
                timeout=700,
            )
        )
        self.assertIn(("click", (700, True)), button.actions)
        click_count = sum(action == "click" for action, _value in button.actions)

        button.visible = False
        with self.assertRaises(PlaywrightRuntimeError):
            page.control_click_element(
                1_000_002,
                expected_role="button",
                expected_name="Continue",
                expected_enabled=True,
                expected_surface_key=1_000_000,
                timeout=701,
            )
        self.assertEqual(
            sum(action == "click" for action, _value in button.actions),
            click_count,
        )

        self.assertTrue(page.control_click_point(75.5, 125.0, timeout=702))
        page.control_scroll_surface(1_000_000, 800, timeout=703)
        self.assertEqual(
            raw.mouse.actions,
            [
                ("move", (75.5, 125.0)),
                ("click", (75.5, 125.0)),
                ("move", (270.0, 280.0)),
                ("wheel", (0, 800)),
            ],
        )
        self.assertEqual(raw.timeout_calls, [100])

        self.assertTrue(page.control_go_back(timeout=704))
        self.assertEqual(raw.go_back_calls, [(704, "commit")])
        self.assertTrue(page.control_wait_for_change(timeout=705))
        self.assertEqual(raw.wait_calls[-1][1:], ("initial-fingerprint", 705))
        raw.wait_timeout = True
        self.assertFalse(page.control_wait_for_change(timeout=706))
        self.assertEqual(raw.wait_calls[-1][1:], ("initial-fingerprint", 706))

    def test_element_text_and_aria_fallback_roles_are_normalized_consistently(self) -> None:
        page, raw, _context, button, _viewer, _child_link = self._page()
        raw_name = "  Download\n\x00 PDF  " + "文" * 100
        button.role = "button switch"
        button.name = raw_name
        elements = cast(list[dict[str, object]], raw.main_frame._scan["elements"])
        elements[0]["role"] = button.role
        elements[0]["name"] = raw_name

        snapshot = page.control_snapshot(timeout=300, include_screenshot=False)

        exposed = cast(tuple[tuple[object, ...], ...], snapshot["elements"])[0]
        self.assertEqual(exposed[2], "button")
        normalized_name = cast(str, exposed[3])
        self.assertTrue(normalized_name.startswith("Download PDF "))
        self.assertNotIn("\n", normalized_name)
        self.assertNotIn("\x00", normalized_name)
        self.assertLessEqual(len(normalized_name.encode("utf-8")), 256)
        self.assertTrue(
            page.control_click_element(
                1_000_002,
                expected_role="button",
                expected_name=normalized_name,
                expected_enabled=True,
                expected_surface_key=1_000_000,
                timeout=700,
            )
        )
        self.assertIn(("click", (700, True)), button.actions)

    def test_document_and_frame_replacement_are_retryable_observation_transitions(self) -> None:
        for message in (
            "Execution context was destroyed, most likely because of a navigation",
            "Frame was detached",
        ):
            with self.subTest(message=message):
                page, raw, _context, _button, _viewer, _child_link = self._page()
                raw.wait_error = RuntimeError(message)

                with self.assertRaises(BrowserObservationUnavailable):
                    page.control_wait_for_change(timeout=200)

        page, raw, _context, _button, _viewer, _child_link = self._page()
        raw.main_frame.evaluate_error = RuntimeError(
            "Execution context was destroyed, most likely because of a navigation"
        )
        with self.assertRaises(BrowserObservationUnavailable):
            page.control_snapshot(timeout=200, include_screenshot=True)

    def test_snapshot_failure_reports_safe_internal_stage(self) -> None:
        page, raw, _context, _button, _viewer, _child_link = self._page()
        raw.main_frame.evaluate_error = RuntimeError("private-page-sentinel")

        with self.assertLogs("sciretriever.network.playwright", level="DEBUG") as logs:
            with self.assertRaises(PlaywrightRuntimeError):
                page.control_snapshot(timeout=200, include_screenshot=True)

        rendered = "\n".join(logs.output)
        self.assertIn("operation=snapshot", rendered)
        self.assertIn("stage=frame-evaluate", rendered)
        self.assertIn("failure_category=other", rendered)
        self.assertNotIn("private-page-sentinel", rendered)

    def test_closed_page_is_visible_to_the_article_session_without_vendor_payload(self) -> None:
        page, raw, _context, _button, _viewer, _child_link = self._page()
        raw.is_closed = True

        self.assertTrue(page.control_is_closed())

    def test_close_releases_all_request_local_vendor_bindings(self) -> None:
        page, raw, context, _button, _viewer, _child_link = self._page()
        page.control_snapshot(timeout=300, include_screenshot=False)
        self.assertTrue(cast(dict[object, object], page._control_element_locators))
        self.assertTrue(cast(dict[object, object], page._control_surface_centers))

        page.close()
        page.close()

        self.assertEqual(page._control_element_locators, {})
        self.assertEqual(page._control_surface_centers, {})
        self.assertEqual(raw.close_calls, 1)
        self.assertEqual(context.forgotten, [page])


if __name__ == "__main__":
    unittest.main()
