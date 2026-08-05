"""Full-text search over the vault — jarvis-os.

SQLite FTS5 index. The index is derived data: it is rebuilt wholesale from the
vault rather than edited, so the vault stays the single source of truth.

Run:
    server/.venv/Scripts/python search.py "kalo funding"
"""
import re
import sqlite3
import sys
from pathlib import Path

from vault import Note, parse_vault

SCRIPT_DIR = Path(__file__).resolve().parent
DB_PATH = SCRIPT_DIR / "search_index.db"

# note_id/title/body/tags are searchable; note_type is stored for results only.
_CREATE = """
CREATE VIRTUAL TABLE notes_fts USING fts5(
    note_id,
    title,
    body,
    tags,
    note_type UNINDEXED
)
"""

# Column weights for ranking: a title hit beats a body hit.
#            note_id  title  body  tags
_WEIGHTS = (10.0, 5.0, 1.0, 3.0)

# Strip FTS5 operators (", *, ^, :, parens, AND/OR/NOT syntax) so a user's
# query can't become a syntax error or an unintended operator.
_STRIP_RE = re.compile(r"[^\w\s-]", re.UNICODE)


def _connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    # A fresh connection per call: sync FastAPI endpoints run on a threadpool
    # and SQLite connections aren't shareable across threads.
    return sqlite3.connect(db_path)


def to_fts_query(raw: str) -> str | None:
    """User text -> a safe FTS5 MATCH expression, or None if nothing usable.

    Each term is quoted as a phrase, so `kalo-ai` searches for the phrase
    rather than tripping the tokenizer. Terms are ANDed.
    """
    terms = [t for t in _STRIP_RE.sub(" ", raw).split() if t]
    if not terms:
        return None
    return " ".join(f'"{t}"' for t in terms)


def build_index(notes: list[Note] | None = None, db_path: Path = DB_PATH) -> int:
    """Rebuild the whole index from the vault. Returns the row count.

    A full rebuild (rather than a diff) keeps this trivially correct — the
    vault is small and the index is disposable.
    """
    if notes is None:
        notes = parse_vault()

    conn = _connect(db_path)
    try:
        conn.execute("DROP TABLE IF EXISTS notes_fts")
        conn.execute(_CREATE)
        conn.executemany(
            "INSERT INTO notes_fts (note_id, title, body, tags, note_type) VALUES (?,?,?,?,?)",
            [
                (
                    note.id,
                    note.title or "",
                    note.body or "",
                    " ".join(str(t) for t in note.tags),
                    note.type or "",
                )
                for note in notes
            ],
        )
        conn.commit()
    finally:
        conn.close()

    return len(notes)


def search(query: str, limit: int = 20, db_path: Path = DB_PATH) -> list[dict]:
    """Matching notes, best first: {id, title, type, snippet, score}."""
    match = to_fts_query(query)
    if match is None:
        return []

    conn = _connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT note_id,
                   title,
                   note_type,
                   snippet(notes_fts, -1, '<<', '>>', '…', 12) AS snippet,
                   bm25(notes_fts, ?, ?, ?, ?) AS score
            FROM notes_fts
            WHERE notes_fts MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (*_WEIGHTS, match, limit),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        # Index not built yet, or a MATCH expression that still upset FTS5.
        raise SearchError(str(exc)) from exc
    finally:
        conn.close()

    return [
        {
            "id": row[0],
            "title": row[1],
            "type": row[2] or None,
            "snippet": row[3],
            "score": round(row[4], 6),
        }
        for row in rows
    ]


class SearchError(Exception):
    """Raised when the index is missing or the query can't be executed."""


if __name__ == "__main__":
    count = build_index()
    print(f"Indexed {count} notes -> {DB_PATH.name}\n")

    queries = sys.argv[1:] or ["kalo funding", "commission", "oauth token", "resume"]
    for q in queries:
        print(f'"{q}"  ->  MATCH {to_fts_query(q)}')
        results = search(q, limit=5)
        if not results:
            print("    (no matches)")
        for r in results:
            print(f"    {r['score']:>9.4f}  {r['id']:<16} {r['snippet'][:80]}")
        print()
