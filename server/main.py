"""Jarvis OS API — FastAPI.

Run:
    server/.venv/Scripts/python -m uvicorn main:app --port 4719 --reload
"""
import asyncio
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

import frontmatter
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from graph import build_graph
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
    task = asyncio.create_task(watch_vault(rebuild_state, stop_event))
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


# --- endpoints --------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/graph")
def graph():
    return get_state()["graph"]


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

    # Validate BEFORE writing: a note that already parses must never be
    # replaced by content that doesn't.
    try:
        frontmatter.loads(update.content)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Malformed frontmatter — nothing was written.",
                "reason": f"{type(exc).__name__}: {str(exc).splitlines()[0]}",
            },
        )

    _atomic_write(note.path, update.content)

    # Re-read from disk so the response reflects what was actually persisted.
    state = get_state()
    saved = state["by_id"].get(note_id)
    if saved is None:
        raise HTTPException(
            status_code=500,
            detail=f"Wrote '{note_id}' but it no longer parses under that id",
        )
    return _full(saved, state["backlinks"].get(saved.id, []))
