#!/usr/bin/env python3
"""Run one bounded Browser Use leaf-agent delegation."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from browser_use import Agent, Browser, ChatBrowserUse, Tools
from lmnr import Attributes, Laminar
from pydantic import BaseModel, ConfigDict, Field


class DelegationLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_steps: int = Field(ge=1, le=25)
    max_actions_per_step: int = Field(ge=1, le=3)
    timeout_seconds: int = Field(ge=1, le=300)


class DelegationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    delegation_id: str = Field(min_length=1)
    parent_session_id: str = Field(min_length=1)
    target_id: str | None = None
    task: str = Field(min_length=1)
    done_when: str = Field(min_length=1)
    limits: DelegationLimits


class DelegationMetrics(BaseModel):
    duration_seconds: float = 0
    steps: int = 0
    actions: int = 0
    cost_usd: float = 0
    total_tokens: int = 0


class ObservedTab(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_id: str
    url: str
    title: str


class ObservedBrowserState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_id: str | None = None
    url: str = ""
    title: str = ""
    tabs: list[ObservedTab] = Field(default_factory=list)
    page_excerpt: str = ""
    page_excerpt_truncated: bool = False
    screenshot_artifact: str | None = None
    captured_at: str
    capture_error: str | None = None


class DelegationResult(BaseModel):
    schema_version: Literal[1] = 1
    delegation_id: str
    status: Literal["completed", "gave_up", "timed_out", "failed"]
    summary: str
    action_digest: list[str] = Field(default_factory=list)
    action_details: list[str] = Field(default_factory=list)
    extracted_content: list[str] = Field(default_factory=list)
    done_condition_claimed: bool = False
    initial_url: str = ""
    initial_title: str = ""
    final_url: str = ""
    observed_state_after: ObservedBrowserState | None = None
    blocker: str | None = None
    uncertainties: list[str] = Field(default_factory=list)
    metrics: DelegationMetrics = Field(default_factory=DelegationMetrics)
    artifacts: list[str] = Field(default_factory=list)
    trace_id: str | None = None


SUBAGENT_PROMPT = """
You are a bounded browser executor for a parent agent. Complete only TASK and
stop when DONE_WHEN is visibly satisfied. Directly observe every value you
return; never guess or broaden the task.

Your done text is the parent's receipt. Include the exact requested values,
records, and links, plus any uncertainty. Never return only "done".

If blocked, ambiguous, missing information, or unlikely to finish within the
budget, call done(success=False). Giving up is correct. Do not use files,
JavaScript, APIs, or debugging tools.
""".strip()

EXCLUDED_ACTIONS = ["read_file", "write_file", "replace_file", "upload_file"]


def write_json(path: Path, value: BaseModel | dict[str, Any]) -> None:
    payload = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    )


def trace_id(serialized_context: str) -> str | None:
    if not serialized_context:
        return None
    try:
        value = json.loads(serialized_context)
    except json.JSONDecodeError:
        return None
    result = value.get("trace_id") or value.get("traceId")
    return result if isinstance(result, str) else None


def action_digest(action_history: list[list[dict[str, Any]]]) -> list[str]:
    digest: list[str] = []
    for step in action_history:
        names = [next(iter(action)) for action in step if action]
        if names:
            digest.append(", ".join(names))
    return digest[-8:]


def _redact_sensitive(value: Any, key: str = "") -> Any:
    if any(part in key.lower() for part in ("password", "token", "secret", "cookie")):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            item_key: _redact_sensitive(item_value, item_key)
            for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [_redact_sensitive(item) for item in value]
    return value


def action_details(action_history: list[list[dict[str, Any]]]) -> list[str]:
    details: list[str] = []
    for step_number, step in enumerate(action_history, start=1):
        for action in step:
            compact_action = {
                key: value
                for key, value in action.items()
                if key != "interacted_element"
            }
            serialized = json.dumps(
                _redact_sensitive(compact_action), ensure_ascii=False, default=str
            )
            details.append(f"step {step_number}: {serialized[:500]}")
    return details[-25:]


def extracted_content(history: Any) -> list[str]:
    values: list[str] = []
    remaining = 6000
    for raw_value in reversed(history.extracted_content()):
        value = str(raw_value or "").strip()
        if not value or value in values:
            continue
        clipped = value[-min(len(value), remaining) :]
        values.append(clipped)
        remaining -= len(clipped)
        if remaining <= 0 or len(values) >= 10:
            break
    return list(reversed(values))


def compact_excerpt(value: str, limit: int = 12000) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    half = (limit - 80) // 2
    return (
        value[:half]
        + "\n\n... browser state excerpt truncated ...\n\n"
        + value[-half:],
        True,
    )


async def observe_browser_state(
    browser: Browser, directory: Path, target_id: str | None
) -> ObservedBrowserState:
    captured_at = datetime.now(UTC).isoformat()
    try:
        async with asyncio.timeout(10):
            state = await browser.get_browser_state_summary(include_screenshot=True)
        page_excerpt, truncated = compact_excerpt(state.dom_state.llm_representation())
        screenshot_artifact: str | None = None
        if state.screenshot:
            screenshot_artifact = "final_state.png"
            (directory / screenshot_artifact).write_bytes(
                base64.b64decode(state.screenshot)
            )
        current_tab = next(
            (
                tab
                for tab in state.tabs
                if tab.url == state.url and tab.title == state.title
            ),
            None,
        )
        return ObservedBrowserState(
            target_id=current_tab.target_id if current_tab else target_id,
            url=state.url,
            title=state.title,
            tabs=[
                ObservedTab(
                    target_id=tab.target_id,
                    url=tab.url,
                    title=tab.title,
                )
                for tab in state.tabs[:10]
            ],
            page_excerpt=page_excerpt,
            page_excerpt_truncated=truncated,
            screenshot_artifact=screenshot_artifact,
            captured_at=captured_at,
        )
    except Exception:  # noqa: BLE001 - direct CDP fallback remains available
        return await observe_browser_state_with_cdp(
            browser=browser,
            directory=directory,
            requested_target_id=target_id,
            captured_at=captured_at,
        )


async def observe_browser_state_with_cdp(
    browser: Browser,
    directory: Path,
    requested_target_id: str | None,
    captured_at: str,
) -> ObservedBrowserState:
    """Capture a compact state directly when Browser Use DOM serialization stalls."""
    errors: list[str] = []
    url = ""
    title = ""
    current_target_id = requested_target_id
    tabs: list[ObservedTab] = []
    page_excerpt = ""
    screenshot_artifact: str | None = None

    try:
        target_info = await browser.get_current_target_info()
        if target_info:
            current_target_id = target_info.get("targetId") or current_target_id
            url = str(target_info.get("url") or "")
            title = str(target_info.get("title") or "")
        tabs = [
            ObservedTab(target_id=tab.target_id, url=tab.url, title=tab.title)
            for tab in (await browser.get_tabs())[:10]
        ]
    except Exception as error:  # noqa: BLE001 - preserve partial final evidence
        errors.append(f"tab capture {type(error).__name__}: {error}")

    try:
        cdp_session = await browser.get_or_create_cdp_session(
            current_target_id, focus=False
        )
        result = await asyncio.wait_for(
            cdp_session.cdp_client.send.Runtime.evaluate(
                params={
                    "expression": """
(() => ({
  url: location.href,
  title: document.title,
  text: (document.body?.innerText || '').slice(0, 12000)
}))()
""".strip(),
                    "returnByValue": True,
                },
                session_id=cdp_session.session_id,
            ),
            timeout=8,
        )
        value = result.get("result", {}).get("value") or {}
        url = str(value.get("url") or url)
        title = str(value.get("title") or title)
        page_excerpt = str(value.get("text") or "")
    except Exception as error:  # noqa: BLE001 - preserve partial final evidence
        errors.append(f"text capture {type(error).__name__}: {error}")

    try:
        screenshot = await asyncio.wait_for(
            browser.take_screenshot(full_page=False), timeout=8
        )
        screenshot_artifact = "final_state.png"
        (directory / screenshot_artifact).write_bytes(screenshot)
    except Exception as error:  # noqa: BLE001 - text evidence can still succeed
        errors.append(f"screenshot capture {type(error).__name__}: {error}")

    if not url or not title:
        url = ""
        title = ""
        try:
            url = await browser.get_current_page_url()
            title = await browser.get_current_page_title()
        except Exception as fallback_error:  # noqa: BLE001 - preserve both failures
            errors.append(
                f"; fallback {type(fallback_error).__name__}: {fallback_error}"
            )

    return ObservedBrowserState(
        target_id=current_target_id,
        url=url,
        title=title,
        tabs=tabs,
        page_excerpt=page_excerpt,
        screenshot_artifact=screenshot_artifact,
        captured_at=captured_at,
        capture_error="; ".join(errors),
    )


async def execute(request: DelegationRequest, directory: Path) -> DelegationResult:
    started = time.monotonic()
    history_path = directory / "history.json"
    events_path = directory / "actions.jsonl"
    context = os.environ.get("LMNR_SPAN_CONTEXT", "")
    cdp_url = os.environ.get("BU_CDP_WS") or os.environ.get("BU_CDP_URL")
    if not cdp_url:
        raise RuntimeError("BU_CDP_WS or BU_CDP_URL is required")

    parent = Laminar.deserialize_span_context(context) if context else None
    browser = Browser(
        cdp_url=cdp_url,
        keep_alive=True,
        accept_downloads=False,
        auto_download_pdfs=False,
    )
    await browser.start()
    if request.target_id:
        target_session = await browser.get_or_create_cdp_session(
            request.target_id, focus=True
        )
        await target_session.cdp_client.send.Target.activateTarget(
            params={"targetId": request.target_id}
        )
    initial_url = await browser.get_current_page_url()
    initial_title = await browser.get_current_page_title()
    write_json(
        directory / "initial_state.json",
        {
            "schema_version": 1,
            "delegation_id": request.delegation_id,
            "target_id": request.target_id,
            "url": initial_url,
            "title": initial_title,
            "captured_at": datetime.now(UTC).isoformat(),
        },
    )
    tools = Tools(exclude_actions=EXCLUDED_ACTIONS)
    task = f"""
TASK
{request.task}

DONE_WHEN
{request.done_when}
""".strip()

    async def checkpoint(agent: Agent) -> None:
        agent.save_history(history_path)
        event = {
            "schema_version": 1,
            "time": datetime.now(UTC).isoformat(),
            "delegation_id": request.delegation_id,
            "type": "step.completed",
            "step": len(agent.history),
            "url": next((url for url in reversed(agent.history.urls()) if url), ""),
            "actions": agent.history.action_history()[-1]
            if agent.history.history
            else [],
            "errors": [error for error in agent.history.errors() if error],
        }
        with events_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        if (
            len(agent.history) >= request.limits.max_steps
            and not agent.history.is_done()
        ):
            agent.stop()

    span_options: dict[str, Any] = {
        "session_id": request.parent_session_id,
        "input": {
            "delegation_id": request.delegation_id,
            "target_id": request.target_id,
            "task": request.task,
            "done_when": request.done_when,
            "limits": request.limits.model_dump(mode="json"),
            "model": os.environ.get("BROWSER_USE_DELEGATE_MODEL", "bu-2-0"),
        },
        "metadata": {
            "delegation.id": request.delegation_id,
            "parent.session_id": request.parent_session_id,
            "subagent.kind": "browser-use",
        },
    }
    if parent is not None:
        span_options["parent_span_context"] = parent

    span_options["span_type"] = "LLM"
    with Laminar.start_as_current_span("browser_use.subagent", **span_options):
        agent = Agent(
            task=task,
            llm=ChatBrowserUse(
                model=os.environ.get("BROWSER_USE_DELEGATE_MODEL", "bu-2-0")
            ),
            browser=browser,
            tools=tools,
            calculate_cost=True,
            source="browsercode_delegate",
            use_judge=False,
            use_vision="auto",
            use_thinking=True,
            max_actions_per_step=request.limits.max_actions_per_step,
            max_failures=2,
            llm_timeout=45,
            step_timeout=60,
            extend_system_message=SUBAGENT_PROMPT,
        )
        history = await agent.run(
            max_steps=request.limits.max_steps, on_step_end=checkpoint
        )
        history.save_to_file(history_path)
        usage = getattr(history, "usage", None)
        usage_data = usage.model_dump(mode="json") if usage is not None else {}
        model = os.environ.get("BROWSER_USE_DELEGATE_MODEL", "bu-2-0")
        Laminar.set_span_output(history.final_result() or "")
        Laminar.set_span_attributes(
            {
                Attributes.PROVIDER: "browser-use",
                Attributes.REQUEST_MODEL: model,
                Attributes.RESPONSE_MODEL: model,
                Attributes.INPUT_TOKEN_COUNT: int(
                    usage_data.get("total_prompt_tokens") or 0
                ),
                Attributes.OUTPUT_TOKEN_COUNT: int(
                    usage_data.get("total_completion_tokens") or 0
                ),
                Attributes.TOTAL_TOKEN_COUNT: int(usage_data.get("total_tokens") or 0),
                "gen_ai.usage.total_tokens": int(usage_data.get("total_tokens") or 0),
                Attributes.TOTAL_COST: float(usage_data.get("total_cost") or 0),
                "delegation.usage.accounting": "aggregate",
            }
        )

    observed_state = await observe_browser_state(browser, directory, request.target_id)
    success = history.is_successful()
    status: Literal["completed", "gave_up"] = (
        "completed" if success is True else "gave_up"
    )
    summary = history.final_result() or (
        "Browser Use reached the delegation step limit without claiming completion."
        if not history.is_done()
        else "Browser Use gave up without a summary."
    )
    urls = [url for url in history.urls() if url]
    result = DelegationResult(
        delegation_id=request.delegation_id,
        status=status,
        summary=summary[-2000:],
        action_digest=action_digest(history.action_history()),
        action_details=action_details(history.action_history()),
        extracted_content=extracted_content(history),
        done_condition_claimed=success is True,
        initial_url=initial_url,
        initial_title=initial_title,
        final_url=observed_state.url or (urls[-1] if urls else ""),
        observed_state_after=observed_state,
        blocker=None if success is True else summary[-1000:],
        metrics=DelegationMetrics(
            duration_seconds=round(time.monotonic() - started, 3),
            steps=len(history),
            actions=len(history.action_names()),
            cost_usd=float(usage_data.get("total_cost") or 0),
            total_tokens=int(usage_data.get("total_tokens") or 0),
        ),
        artifacts=[
            "request.json",
            "initial_state.json",
            "final_state.json",
            *(
                [observed_state.screenshot_artifact]
                if observed_state.screenshot_artifact
                else []
            ),
            "result.json",
            "history.json",
            "actions.jsonl",
            "stdout.log",
            "stderr.log",
        ],
        trace_id=trace_id(context),
    )
    write_json(directory / "final_state.json", observed_state)
    await browser.stop()
    return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    result_path = Path(args.result).resolve()
    directory = result_path.parent
    request = DelegationRequest.model_validate_json(request_path.read_text())
    started = time.monotonic()
    tracing_initialized = False
    try:
        if os.environ.get("LMNR_PROJECT_API_KEY"):
            Laminar.initialize()
            tracing_initialized = True
        result = await execute(request, directory)
    except Exception as error:  # noqa: BLE001 - persist a structured failure for the parent
        traceback.print_exc()
        result = DelegationResult(
            delegation_id=request.delegation_id,
            status="failed",
            summary=f"{type(error).__name__}: {error}",
            blocker=f"{type(error).__name__}: {error}",
            metrics=DelegationMetrics(
                duration_seconds=round(time.monotonic() - started, 3)
            ),
            artifacts=["request.json", "result.json", "stdout.log", "stderr.log"],
            trace_id=trace_id(os.environ.get("LMNR_SPAN_CONTEXT", "")),
        )
    write_json(result_path, result)
    if tracing_initialized:
        Laminar.flush()
        Laminar.shutdown()
    return 0 if result.status != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
