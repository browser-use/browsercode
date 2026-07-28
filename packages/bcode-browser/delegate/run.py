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
You are a browser episode executor working for a parent BrowserCode agent.

Complete the requested episode, but nothing outside it. It may contain several
pages or interactions explicitly named in TASK. Stop as soon as DONE_WHEN is
visibly satisfied. You do not own the user's overall task or final answer.

Your done text is the receipt used by the parent: include the exact requested
values, records, and links plus any uncertainty. Never return only "done".

If the episode is ambiguous, blocked, requires guessing, filesystem work,
JavaScript/API reverse engineering, or more work than the budget allows, call
done(success=False). Giving up is correct and encouraged. Never claim success
without visible evidence. Do not use or create files.
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
            serialized = json.dumps(
                _redact_sensitive(action), ensure_ascii=False, default=str
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
        async with asyncio.timeout(20):
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
    except Exception as error:  # noqa: BLE001 - final evidence is best-effort
        url = ""
        title = ""
        capture_error = f"{type(error).__name__}: {error}"
        try:
            url = await browser.get_current_page_url()
            title = await browser.get_current_page_title()
        except Exception as fallback_error:  # noqa: BLE001 - preserve both failures
            capture_error += (
                f"; fallback {type(fallback_error).__name__}: {fallback_error}"
            )
        return ObservedBrowserState(
            target_id=target_id,
            url=url,
            title=title,
            captured_at=captured_at,
            capture_error=capture_error,
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
