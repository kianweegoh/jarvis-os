"""Standalone MCP tools — jarvis-os, Day 43.

The first tool defined outside agent.py: get_active_projects, a read-only
vault query that lives as its own MCP server (mcp__vault__*) rather than
being folded into the "jarvis" server that holds Day 34's
propose_note_write. Proves a standalone, reusable server can be registered
alongside agent.py's internal one via `mcp_servers`, before Day 44 wires in
a real *external* server (Kalo Ads OS).

Reuses vault.py's parse_vault() rather than re-walking/re-parsing the vault
a second way — one parser, every consumer.

Note on the directory name: NOT `server/mcp/`, despite that empty scaffold
existing from Day 1. `claude_agent_sdk` depends on the real `mcp` PyPI
package internally, and the app is launched as
`python -m uvicorn main:app` from server/ as cwd — which puts server/ on
sys.path ahead of site-packages. A local `server/mcp/` package would shadow
the real one for every `import mcp` in the process. Confirmed empirically
before naming this directory `mcp_tools/` instead.
"""
import sys
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

# vault.py lives in server/, one level up from server/mcp_tools/. agent.py
# gets this for free (it lives in server/ itself, which is already on
# sys.path as the uvicorn cwd) — this file needs the explicit parent
# so `from vault import parse_vault` resolves the same way.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from vault import parse_vault  # noqa: E402

GET_ACTIVE_PROJECTS_TOOL = "get_active_projects"


def _active_projects() -> list[dict[str, Any]]:
    """Vault notes with type: project and status: active, as plain dicts.

    Read-only — parse_vault() only ever reads from disk, same guarantee
    vault.py itself makes.
    """
    notes = parse_vault()
    return [
        {"id": n.id, "title": n.title or n.id}
        for n in notes
        if n.type == "project" and n.status == "active"
    ]


@tool(
    GET_ACTIVE_PROJECTS_TOOL,
    "List the user's currently active projects — vault notes with "
    "type: project and status: active. Use this whenever asked what "
    "projects are actively being worked on right now, rather than "
    "guessing from conversation history.",
    {"type": "object", "properties": {}},
)
async def _get_active_projects(args: dict[str, Any]) -> dict[str, Any]:
    projects = _active_projects()
    if not projects:
        text = "No active projects found in the vault."
    else:
        text = "Active projects:\n" + "\n".join(
            f"- {p['title']} ({p['id']})" for p in projects
        )
    return {"content": [{"type": "text", "text": text}]}


# Separate server name ("vault", not "jarvis") — this is what actually
# proves the standalone-server pattern: agent.py's mcp_servers dict holds
# two independently-defined servers, not one growing tool list.
VAULT_TOOLS = create_sdk_mcp_server("vault", tools=[_get_active_projects])
