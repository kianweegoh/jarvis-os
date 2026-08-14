"""Jarvis OS API — FastAPI.

Run:
    server/.venv/Scripts/python -m uvicorn main:app --port 4719 --reload
"""
import asyncio
import json
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

import frontmatter
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import agent
from graph import build_graph, top_hubs
from search import SearchError, build_index
from search import search as search_notes
from vault import VAULT_DIR, Note, build_backlinks, parse_vault, vault_fingerprint
from watcher import watch_vault


# --- derived-data cache -----------------------------------------------------
# Everything downstream of the vault's content lives here and is rebuilt as a
# set: parse -> graph, backlinks, FTS index. Readers take a single reference,
# so a rebuild swapping `_state` can never be observed half-applied.
_state: dict = {
    "fingerprint": None,
    "notes": [],
    "backlinks": {},
    "by_id": {},
    "graph": {"nodes": [], "links": [], "broken_links": []},
}
_rebuild_lock = threading.Lock()


def rebuild_state() -> dict:
    """Re-derive everything from the vault. Blocking; safe to call from a thread."""
    global _state
    with _rebuild_lock:
        notes = parse_vault()
        build_index(notes)
        _state = {
            "fingerprint": vault_fingerprint(),
            "notes": notes,
            "backlinks": build_backlinks(notes),
            "by_id": {note.id: note for note in notes},
            "graph": build_graph(notes),
        }
        return _state


def get_state() -> dict:
    """Current derived data.

    The file watcher is the primary freshness mechanism — it rebuilds on
    change. This per-request fingerprint check is kept as a fallback for the
    cases the watcher can't cover: the window before startup completes, or a
    watcher that has died. It is cheap (stat only) and belt-and-suspenders.
    """
    state = _state
    if vault_fingerprint() != state["fingerprint"]:
        return rebuild_state()
    return state


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Build once up front so the first request doesn't pay for it.
    await asyncio.to_thread(rebuild_state)

    stop_event = asyncio.Event()
    task = asyncio.create_task(
        watch_vault(rebuild_state, stop_event, on_changed_paths=agent.on_vault_changed)
    )
    try:
        yield
    finally:
        stop_event.set()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="Jarvis OS API", lifespan=lifespan)


def _summary(note: Note) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "type": note.type,
        "tags": note.tags,
        "updated": note.updated,
    }


def _full(note: Note, backlinks: list[str]) -> dict:
    return {
        "id": note.id,
        "type": note.type,
        "title": note.title,
        "tags": note.tags,
        "status": note.status,
        "created": note.created,
        "updated": note.updated,
        "links": note.links,
        "backlinks": backlinks,
        "body": note.body,
        "path": str(note.path.relative_to(VAULT_DIR)) if note.path else None,
        "parse_error": note.parse_error,
    }


class NoteUpdate(BaseModel):
    content: str


class AgentMessage(BaseModel):
    message: str
    # Day 33: context-aware chat. IDs only — main.py resolves them against
    # the already-parsed/cached vault state (get_state()["by_id"]) rather
    # than duplicating vault.py's parsing, and hands agent.py the resolved
    # bodies. open_note_id is kept distinct from attached_note_ids end to
    # end (not just merged into one list) so "summarize this" can still
    # resolve unambiguously even when other notes are also attached.
    open_note_id: str | None = None
    attached_note_ids: list[str] = Field(default_factory=list)


def _resolve_context_notes(body: AgentMessage) -> list[agent.ContextNote]:
    """AgentMessage's note ids -> agent.ContextNote's with real content.

    Unknown/deleted ids are skipped rather than erroring the whole
    request — the same resilience-over-strictness call the rest of this
    file makes for supplementary lookups.
    """
    by_id = get_state()["by_id"]
    notes: list[agent.ContextNote] = []

    if body.open_note_id:
        note = by_id.get(body.open_note_id)
        if note is not None:
            notes.append(
                agent.ContextNote(id=note.id, title=note.title, role="open", body=note.body)
            )

    for note_id in body.attached_note_ids:
        if note_id == body.open_note_id:
            continue  # already included above as the open note
        note = by_id.get(note_id)
        if note is not None:
            notes.append(
                agent.ContextNote(id=note.id, title=note.title, role="attached", body=note.body)
            )

    return notes


def _atomic_write(path: Path, content: str) -> None:
    """Write via temp file + os.replace so a failure can't truncate the note."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def _validate_and_write(path: Path, content: str, note_id: str) -> Note:
    """Day 17's write path: validate frontmatter parses, atomic-write, then
    re-read from disk so the return value reflects what was actually
    persisted — not just what was requested.

    The ONE write mechanism in this file. PUT /api/notes/{note_id} and the
    Day 34 proposal-approve endpoint both call this and nothing else; there
    is no second path that reaches _atomic_write.
    """
    try:
        frontmatter.loads(content)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Malformed frontmatter — nothing was written.",
                "reason": f"{type(exc).__name__}: {str(exc).splitlines()[0]}",
            },
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, content)

    state = get_state()
    saved = state["by_id"].get(note_id)
    if saved is None:
        raise HTTPException(
            status_code=500,
            detail=f"Wrote '{note_id}' but it no longer parses under that id",
        )
    return saved


def _resolve_proposal_path(target_path: str | None, note_id: str) -> Path:
    """A proposal's `target_path` is model output, not trusted input — this
    is the one place that turns it into an actual filesystem path, and it
    refuses anything that would land outside the vault (e.g. '../../etc/x').
    """
    rel = (target_path or f"{note_id}.md").strip().lstrip("/\\")
    if not rel.endswith(".md"):
        rel = f"{rel}.md"

    vault_root = VAULT_DIR.resolve()
    path = (VAULT_DIR / rel).resolve()
    if path != vault_root and vault_root not in path.parents:
        raise HTTPException(
            status_code=400,
            detail=f"Proposed path '{target_path}' escapes the vault — refusing to write",
        )
    return path


def _render_proposal_content(proposal: dict) -> str:
    """Reassembles a proposal's separate frontmatter/content fields into one
    file body via python-frontmatter — the same library Day 17's validation
    already parses with, so what gets validated is built the same way real
    notes are, not a second hand-rolled format.
    """
    metadata = dict(proposal["frontmatter"])
    metadata["id"] = proposal["note_id"]
    metadata["title"] = proposal["title"]
    post = frontmatter.Post(proposal["content"], **metadata)
    return frontmatter.dumps(post)


# --- endpoints --------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/agent/info")
def agent_info():
    """Day 32: lets the HUD show the real model instead of a second hardcoded
    copy that can drift — `agent.MODEL` is the only place it's defined."""
    return {"model": agent.MODEL}


@app.post("/api/agent/test")
async def agent_test(body: AgentMessage):
    """Day 29: prove the agent loop — no streaming, no tools yet."""
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="'message' is required")
    reply = await agent.ask(body.message, context_notes=_resolve_context_notes(body))
    return {"response": reply}


async def _sse_events(body: AgentMessage):
    """agent.stream()'s dicts, wire-formatted as SSE `data:` lines.

    One convention throughout: event type lives in the JSON payload's "type"
    key, not the SSE "event:" field — every event arrives as a plain
    `message` event on the client, distinguished by `data.type`.
    """
    context_notes = _resolve_context_notes(body)
    async for event in agent.stream(body.message, context_notes=context_notes):
        yield f"data: {json.dumps(event)}\n\n"


@app.post("/api/chat")
async def chat(body: AgentMessage):
    """Day 30: streaming counterpart to /api/agent/test — SSE, not one blob.

    Day 33: `body` may also carry `open_note_id`/`attached_note_ids` —
    resolved to real note content up front, before the SSE response even
    starts.
    """
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="'message' is required")
    return StreamingResponse(
        _sse_events(body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/graph")
def graph():
    return get_state()["graph"]


@app.get("/api/graph/hubs")
def graph_hubs(limit: int = 10):
    """The most-connected notes — pulled from cached graph state, not re-derived."""
    return {"hubs": top_hubs(get_state()["graph"]["nodes"], limit=limit)}


@app.get("/api/stats")
def stats():
    """Counts only — pulled from the cached parse/graph state, never re-derived."""
    state = get_state()
    notes = state["notes"]

    by_type: dict[str, int] = {}
    for note in notes:
        key = note.type or "(no type)"
        by_type[key] = by_type.get(key, 0) + 1

    return {
        "total_notes": len(notes),
        "by_type": by_type,
        "total_edges": len(state["graph"]["links"]),
    }


@app.get("/api/brief/today")
def brief_today():
    """Today's daily note, rendered (frontmatter stripped, body + metadata)."""
    today = date.today().isoformat()
    state = get_state()
    note = state["by_id"].get(today)
    if note is None or note.type != "daily":
        raise HTTPException(status_code=404, detail=f"No daily note for {today}")
    return _full(note, state["backlinks"].get(note.id, []))


@app.get("/api/notes")
def list_notes(type: str | None = None, tag: str | None = None):
    """Summaries only — a list doesn't need every note's body."""
    notes = get_state()["notes"]

    if type is not None:
        notes = [n for n in notes if (n.type or "").lower() == type.lower()]
    if tag is not None:
        wanted = tag.lower()
        notes = [n for n in notes if any(str(t).lower() == wanted for t in n.tags)]

    return {"count": len(notes), "notes": [_summary(n) for n in notes]}


@app.get("/api/search")
def search(q: str = "", limit: int = 20):
    # Touch state first so the index is rebuilt if the vault changed.
    get_state()

    if not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' is required")

    try:
        results = search_notes(q, limit=limit)
    except SearchError as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {exc}")

    return {"query": q, "count": len(results), "results": results}


@app.get("/api/notes/{note_id}")
def get_note(note_id: str):
    state = get_state()
    note = state["by_id"].get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail=f"No note with id '{note_id}'")
    return _full(note, state["backlinks"].get(note.id, []))


@app.put("/api/notes/{note_id}")
def update_note(note_id: str, update: NoteUpdate):
    state = get_state()
    note = state["by_id"].get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail=f"No note with id '{note_id}'")
    if note.path is None:
        raise HTTPException(status_code=409, detail=f"Note '{note_id}' has no file path")

    saved = _validate_and_write(note.path, update.content, note_id)
    return _full(saved, get_state()["backlinks"].get(saved.id, []))


@app.post("/api/notes/proposals/{proposal_id}/approve")
def approve_proposal(proposal_id: str):
    """Day 34: the only path from a model-proposed write to an actual file.

    Resolves a path authoritatively server-side (an existing note's real
    on-disk path for 'edit', a vault-relative-and-validated path for
    'create') rather than trusting the proposal blindly, then hands off to
    the exact same `_validate_and_write` a manual PUT uses.
    """
    proposal = agent.get_proposal(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail=f"No pending proposal '{proposal_id}'")

    state = get_state()
    note_id = proposal["note_id"]

    if proposal["action"] == "edit":
        existing = state["by_id"].get(note_id)
        if existing is None or existing.path is None:
            raise HTTPException(
                status_code=409, detail=f"Note '{note_id}' no longer exists — cannot edit"
            )
        path = existing.path
    elif proposal["action"] == "create":
        if note_id in state["by_id"]:
            raise HTTPException(
                status_code=409, detail=f"Note '{note_id}' already exists — cannot create"
            )
        path = _resolve_proposal_path(proposal.get("target_path"), note_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown proposal action '{proposal['action']}'")

    content = _render_proposal_content(proposal)
    saved = _validate_and_write(path, content, note_id)
    # One-shot: a proposal is consumed the moment it's successfully written,
    # same as it is on reject — either way it can't be approved twice.
    agent.discard_proposal(proposal_id)
    return _full(saved, get_state()["backlinks"].get(saved.id, []))


@app.post("/api/notes/proposals/{proposal_id}/reject")
def reject_proposal(proposal_id: str):
    """Discards a pending proposal. No file is touched — there is nothing
    to undo because nothing was ever written."""
    proposal = agent.discard_proposal(proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail=f"No pending proposal '{proposal_id}'")
    return {"id": proposal_id, "status": "rejected"}
