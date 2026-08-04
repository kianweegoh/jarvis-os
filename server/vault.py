"""Vault parser — jarvis-os.

Walks vault/, parses every .md file into a Note, and reports (never fixes)
wikilinks that point at notes which don't exist.

Read-only by design: nothing here writes, moves, or modifies a file.

Run:
    server/.venv/Scripts/python vault.py
"""
import re
from dataclasses import dataclass, field
from pathlib import Path

import frontmatter

# Resolve against this file's location, not the caller's cwd — same fix as
# gcal.py / gmail.py (see jarvis-os.md, Day 8/9).
SCRIPT_DIR = Path(__file__).resolve().parent
VAULT_DIR = SCRIPT_DIR.parent / "vault"

WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


@dataclass
class Note:
    id: str
    type: str | None
    title: str | None
    tags: list[str] = field(default_factory=list)
    status: str | None = None
    created: str | None = None
    updated: str | None = None
    links: list[str] = field(default_factory=list)
    body: str = ""
    path: Path | None = None
    # Set when the YAML frontmatter wouldn't parse. The note is still returned
    # (id from filename, links still extracted) so one malformed file can't
    # blind the parser to the rest of the vault.
    parse_error: str | None = None


def _normalize_link(target: str) -> str:
    """Strip alias and heading syntax: [[note|shown]] / [[note#heading]] -> note."""
    return target.split("|")[0].split("#")[0].strip()


def extract_links(body: str) -> list[str]:
    """All [[wikilink]] targets in body, de-duplicated, in first-seen order."""
    seen: dict[str, None] = {}
    for match in WIKILINK_RE.findall(body):
        target = _normalize_link(match)
        if target:
            seen.setdefault(target, None)
    return list(seen)


def parse_note(path: Path) -> Note:
    # Explicit utf-8: the vault contains em-dashes, emoji and CJK, which would
    # fail under Windows' default cp1252.
    raw = path.read_text(encoding="utf-8")

    try:
        post = frontmatter.loads(raw)
        meta, content = post.metadata, post.content
    except Exception as exc:
        # Report, don't fix — same contract as broken links. A malformed
        # frontmatter block still yields a usable note for link-checking.
        return Note(
            id=path.stem,
            type=None,
            title=None,
            links=extract_links(raw),
            body=raw,
            path=path,
            parse_error=f"{type(exc).__name__}: {str(exc).splitlines()[0]}",
        )

    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]

    return Note(
        # Frontmatter id wins over the filename: USER.md declares `id: user`,
        # and links are written [[user]]. Falling back to the stem alone would
        # report those as broken.
        id=str(meta.get("id") or path.stem),
        type=meta.get("type"),
        title=meta.get("title"),
        tags=list(tags),
        status=meta.get("status"),
        created=str(meta["created"]) if meta.get("created") else None,
        updated=str(meta["updated"]) if meta.get("updated") else None,
        links=extract_links(content),
        body=content,
        path=path,
    )


def parse_vault(vault_dir: Path = VAULT_DIR) -> list[Note]:
    """Every .md file under vault_dir, recursively."""
    return [parse_note(p) for p in sorted(vault_dir.rglob("*.md"))]


def find_broken_links(notes: list[Note]) -> list[tuple[str, str]]:
    """(source_note_id, missing_target) for every link with no matching note.

    Reports only — nothing is modified or removed.
    """
    known = {n.id for n in notes}
    broken = []
    for note in notes:
        for target in note.links:
            if target not in known:
                broken.append((note.id, target))
    return broken


if __name__ == "__main__":
    notes = parse_vault()

    print(f"Total notes: {len(notes)}")

    print("\nBy type:")
    counts: dict[str, int] = {}
    for note in notes:
        counts[note.type or "(no type)"] = counts.get(note.type or "(no type)", 0) + 1
    for note_type, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {note_type:<12} {count}")

    broken = find_broken_links(notes)
    print(f"\nBroken links: {len(broken)}")
    for source, target in broken:
        print(f"  [[{target}]]  <- {source}")

    failed = [n for n in notes if n.parse_error]
    print(f"\nUnparseable frontmatter: {len(failed)}")
    for note in failed:
        rel = note.path.relative_to(VAULT_DIR) if note.path else note.id
        print(f"  {rel}")
        print(f"    {note.parse_error}")
