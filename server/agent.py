"""Agent loop — jarvis-os, Day 29.

Wraps the Claude Agent SDK with Jarvis's system prompt: vault/CLAUDE.md +
vault/USER.md + vault/MEMORY.md, concatenated. No tools yet — that's later
this week; today just proves the loop answers using the vault's context.
"""
import asyncio
import threading
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

from vault import VAULT_DIR

# The three files the system prompt is assembled from, in the order they're
# concatenated. Watched individually so an edit to any one invalidates the
# cache without needing a full vault rebuild.
CONTEXT_FILES = [
    VAULT_DIR / "CLAUDE.md",
    VAULT_DIR / "USER.md",
    VAULT_DIR / "MEMORY.md",
]

MODEL = "claude-sonnet-5"

# --- system-prompt cache -----------------------------------------------------
# Assembly is cheap (three small file reads + a join) but there's no reason to
# pay it on every request when the watcher already tells us when the source
# files change. Module-level so it survives across requests within one server
# process; rebuilt in place, never left half-written.
_cache_lock = threading.Lock()
_system_prompt: str | None = None


def _read_context_file(path: Path) -> str:
    if not path.exists():
        return ""
    # Explicit utf-8: same reasoning as vault.py — these files carry
    # em-dashes and other non-ASCII content that cp1252 can't round-trip.
    return path.read_text(encoding="utf-8")


def assemble_system_prompt() -> str:
    """Concatenate CLAUDE.md + USER.md + MEMORY.md under clear section headers."""
    sections = []
    for path in CONTEXT_FILES:
        content = _read_context_file(path).strip()
        sections.append(f"# ===== {path.name} =====\n\n{content}")
    return "\n\n".join(sections)


def get_system_prompt() -> str:
    """The cached system prompt, assembling it on first use."""
    global _system_prompt
    with _cache_lock:
        if _system_prompt is None:
            _system_prompt = assemble_system_prompt()
        return _system_prompt


def invalidate_system_prompt() -> None:
    """Drop the cache so the next request re-assembles from disk.

    Call this when the watcher reports a change to one of CONTEXT_FILES —
    don't reread on every request, don't cache forever.
    """
    global _system_prompt
    with _cache_lock:
        _system_prompt = None


def is_context_file(path: str) -> bool:
    """True if `path` (as reported by the watcher) is one of CONTEXT_FILES."""
    changed = Path(path).resolve()
    return any(changed == ctx.resolve() for ctx in CONTEXT_FILES)


def on_vault_changed(changed_paths: set[str]) -> None:
    """Watcher hook — pass as `on_changed_paths` to `watch_vault`.

    Fires on every raw change batch, undebounced. Only invalidates when a
    CONTEXT_FILES path is actually among the changes, so edits elsewhere in
    the vault (daily notes, projects, etc.) don't force a needless
    reassembly on the next request.
    """
    if any(is_context_file(p) for p in changed_paths):
        invalidate_system_prompt()


# --- agent loop ---------------------------------------------------------------
async def ask(message: str) -> str:
    """Run `message` through the Agent SDK with the cached system prompt.

    Zero tools — this only proves the loop and the system-prompt wiring.
    Concatenates all TextBlocks from the assistant's reply; multi-turn tool
    use isn't in play yet since tools are disabled.
    """
    options = ClaudeAgentOptions(
        system_prompt=get_system_prompt(),
        tools=[],  # no tools yet — Day 29 is loop-only
        model=MODEL,
    )

    reply_parts: list[str] = []
    async for msg in query(prompt=message, options=options):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    reply_parts.append(block.text)

    return "".join(reply_parts)


def ask_sync(message: str) -> str:
    """Sync wrapper for callers outside an event loop (e.g. a quick CLI check)."""
    return asyncio.run(ask(message))


if __name__ == "__main__":
    import sys

    # Same fix as gmail.py: Windows console defaults stdout to cp1252, which
    # can't encode the vault's em-dashes/emoji — reconfigure before printing.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    prompt = " ".join(sys.argv[1:]) or "Who am I?"
    print(ask_sync(prompt))
