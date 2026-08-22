"""Standalone MCP tools — jarvis-os, Day 44.

The first *external* MCP server: two read-only tools against the real
marketing OS ("Kalo Ads OS") running at localhost:3000 —
get_campaign_stats and get_spend_summary. Same standalone-server pattern
Day 43 proved with vault_tools.py's get_active_projects, now pointed at a
system outside this process for the first time.

Auth: POST /api/auth with the shared password (server/.env's
MARKETING_OS_PASSWORD — never the vault, never passed to the model), holds
the resulting `marketing_os_session` cookie on a requests.Session, and
re-authenticates once if a call comes back redirected to /login. That
project's own middleware (src/middleware.ts) protects every route except
/api/auth and static assets by redirecting unauthenticated requests to
/login rather than returning 401 — `requests` follows redirects by
default, so an expired/rejected session surfaces as a 200 whose final URL
is /login (HTML), not an error status. Checked for explicitly below.

Read-only, by design and by omission: only GET /api/metrics is ever
called. /api/agents/{id}/run and /api/orchestrator (real agent runs, real
cost) are explicitly out of scope — nothing in this file references them.

Ground-truth note: the task described get_campaign_stats(days) as if the
server took a `days` query param — it doesn't. Verified by reading that
project's own src/app/api/metrics/route.ts directly rather than guessing:
GET /api/metrics returns only its own most-recent-30-rows limit, no
filtering params, and each row is a *week* (weekStart/weekEnd), not a day.
`days` is therefore applied client-side here, filtering the returned rows
by weekStart.
"""
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from claude_agent_sdk import create_sdk_mcp_server, tool
from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent.parent
load_dotenv(SERVER_DIR / ".env")

BASE_URL = os.environ.get("MARKETING_OS_URL", "http://localhost:3000")
PASSWORD = os.environ.get("MARKETING_OS_PASSWORD")
SESSION_COOKIE_NAME = "marketing_os_session"  # mirrors that project's SESSION_COOKIE constant

_state_lock = threading.Lock()
_session = requests.Session()
_authenticated = False


class MarketingOSError(Exception):
    """Raised for anything a tool handler should report as a clean error
    rather than an unhandled exception — missing password, connection
    refused, repeated auth failure."""


def _login() -> None:
    global _authenticated
    if not PASSWORD:
        raise MarketingOSError(
            "MARKETING_OS_PASSWORD is not set in server/.env — cannot "
            "authenticate to the marketing OS."
        )
    resp = _session.post(f"{BASE_URL}/api/auth", json={"password": PASSWORD}, timeout=10)
    resp.raise_for_status()
    if SESSION_COOKIE_NAME not in _session.cookies.get_dict():
        raise MarketingOSError("Login succeeded but no session cookie was set.")
    with _state_lock:
        _authenticated = True


def _looks_unauthenticated(resp: requests.Response) -> bool:
    """True if `resp` is the middleware's redirect-to-/login, not real data."""
    if any(r.status_code in (301, 302, 307, 308) for r in resp.history):
        return True
    return "/login" in resp.url


def _get(path: str) -> Any:
    """GET `path` against the marketing OS, logging in first (or again)
    exactly when needed — never more than one retry, so a genuinely wrong
    password fails loudly instead of looping."""
    global _authenticated
    with _state_lock:
        already_authenticated = _authenticated
    if not already_authenticated:
        _login()

    resp = _session.get(f"{BASE_URL}{path}", timeout=10)
    if _looks_unauthenticated(resp):
        with _state_lock:
            _authenticated = False
        _login()
        resp = _session.get(f"{BASE_URL}{path}", timeout=10)
        if _looks_unauthenticated(resp):
            raise MarketingOSError(
                "Still redirected to /login after re-authenticating — "
                "check MARKETING_OS_PASSWORD in server/.env."
            )

    resp.raise_for_status()
    return resp.json()


def _recent_metrics() -> list[dict[str, Any]]:
    """GET /api/metrics' up-to-30 most recent rows, newest first — the
    server's own limit (HISTORY_LIMIT), not something this file controls."""
    data = _get("/api/metrics")
    return data.get("metrics", [])


def _within_days(rows: list[dict[str, Any]], days: int) -> list[dict[str, Any]]:
    """Rows whose weekStart falls within the last `days` days.

    Client-side filter — see the module docstring for why: GET /api/metrics
    has no date-range param of its own.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    return [
        row
        for row in rows
        if datetime.fromisoformat(row["weekStart"].replace("Z", "+00:00")) >= cutoff
    ]


def _freshness_note(rows: list[dict[str, Any]]) -> str:
    """A one-line freshness signal, always appended to a successful
    response so staleness/sparsity is visible rather than inferred — Day
    45: a tool returning correct-but-old data with no cue reads to the
    model (and then the user) as current.

    `rows` should be the *unfiltered* recent-metrics list, newest first
    (see `_recent_metrics`), so this reflects what's actually available
    rather than just what a `days` window happened to keep.
    """
    if not rows:
        return "No campaign metrics recorded yet."
    newest = rows[0]
    week_end = datetime.fromisoformat(newest["weekEnd"].replace("Z", "+00:00"))
    days_ago = (datetime.now(timezone.utc) - week_end).days
    return (
        f"Most recent data available: week of {newest['weekStart'][:10]} "
        f"(ended {newest['weekEnd'][:10]}, {days_ago} day(s) ago)."
    )


GET_CAMPAIGN_STATS_TOOL = "get_campaign_stats"
GET_SPEND_SUMMARY_TOOL = "get_spend_summary"


@tool(
    GET_CAMPAIGN_STATS_TOOL,
    "Weekly campaign performance rows from the marketing OS (Kalo Ads OS) "
    "covering roughly the last N days — spend, installs, CPI, CTR, trial "
    "conversion, and retention, per platform per week. The underlying data "
    "is recorded weekly, not daily: 'days' selects which recent weeks to "
    "include, it does not produce a daily breakdown. If asked about a "
    "specific day (e.g. 'yesterday' or 'how did we do today'), say plainly "
    "that only weekly aggregates exist here — never present a week's "
    "figure as if it were that single day's number. Every response also "
    "states the most recent data available, so check that line before "
    "treating the numbers as current.",
    {
        "type": "object",
        "properties": {
            "days": {
                "type": "integer",
                "description": "How many days back to include, measured from each row's week-start date.",
            }
        },
        "required": ["days"],
    },
)
async def _get_campaign_stats(args: dict[str, Any]) -> dict[str, Any]:
    days = args.get("days")
    if not isinstance(days, int) or days <= 0:
        return {
            "content": [{"type": "text", "text": "`days` must be a positive integer."}],
            "is_error": True,
        }

    try:
        all_rows = _recent_metrics()
    except (MarketingOSError, requests.RequestException) as exc:
        return {
            "content": [{"type": "text", "text": f"Marketing OS unreachable: {exc}"}],
            "is_error": True,
        }

    rows = _within_days(all_rows, days)
    freshness = _freshness_note(all_rows)

    if not rows:
        text = (
            f"No campaign metric rows in the last {days} days."
            if not all_rows
            else f"No campaign metric rows in the last {days} days. {freshness}"
        )
    else:
        lines = [f"Campaign metrics, last {days} days ({len(rows)} weekly row(s)):"]
        for row in rows:
            lines.append(
                f"- {row['platform']} | week {row['weekStart'][:10]}–{row['weekEnd'][:10]} | "
                f"spend ${row['totalSpend']:.2f} | installs {row['installs']} | "
                f"CPI ${row['cpi']:.2f} | CTR {row['ctr']}% | "
                f"trial-conv {row['trialConversionRate']}% | "
                f"D7 ret {row['day7Retention']}% | D30 ret {row['day30Retention']}%"
            )
        lines.append("")
        lines.append(freshness)
        text = "\n".join(lines)

    return {"content": [{"type": "text", "text": text}]}


@tool(
    GET_SPEND_SUMMARY_TOOL,
    "Aggregated spend/performance summary across the marketing OS's "
    "recent campaign history (the same source as get_campaign_stats, "
    "summarized rather than listed row by row) — total spend, total "
    "installs, blended CPI, average CTR, broken down per platform. The "
    "underlying data is recorded weekly, not daily — if asked about a "
    "specific day, say plainly that only weekly aggregates exist rather "
    "than presenting this summary as a daily figure. The response also "
    "states the most recent data available, so check that line before "
    "treating the numbers as current.",
    {"type": "object", "properties": {}},
)
async def _get_spend_summary(args: dict[str, Any]) -> dict[str, Any]:
    try:
        rows = _recent_metrics()
    except (MarketingOSError, requests.RequestException) as exc:
        return {
            "content": [{"type": "text", "text": f"Marketing OS unreachable: {exc}"}],
            "is_error": True,
        }

    if not rows:
        return {"content": [{"type": "text", "text": "No campaign metrics recorded yet."}]}

    by_platform: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_platform.setdefault(row["platform"], []).append(row)

    total_spend = sum(r["totalSpend"] for r in rows)
    total_installs = sum(r["installs"] for r in rows)
    blended_cpi = total_spend / total_installs if total_installs else 0.0
    avg_ctr = sum(r["ctr"] for r in rows) / len(rows)

    lines = [
        f"Spend summary across {len(rows)} recorded week(s) "
        f"({rows[-1]['weekStart'][:10]} to {rows[0]['weekEnd'][:10]}):",
        f"- Total spend: ${total_spend:.2f}",
        f"- Total installs: {total_installs}",
        f"- Blended CPI: ${blended_cpi:.2f}",
        f"- Average CTR: {avg_ctr:.2f}%",
        "",
        "By platform:",
    ]
    for platform, prows in sorted(by_platform.items()):
        p_spend = sum(r["totalSpend"] for r in prows)
        p_installs = sum(r["installs"] for r in prows)
        p_cpi = p_spend / p_installs if p_installs else 0.0
        lines.append(
            f"- {platform}: {len(prows)} week(s), spend ${p_spend:.2f}, "
            f"installs {p_installs}, blended CPI ${p_cpi:.2f}"
        )
    lines.append("")
    lines.append(_freshness_note(rows))

    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


# Third independent server, alongside Day 34's "jarvis" and Day 43's
# "vault" — underscore, not hyphen, matching the module name and every
# other server registered so far.
MARKETING_OS_TOOLS = create_sdk_mcp_server(
    "marketing_os", tools=[_get_campaign_stats, _get_spend_summary]
)
