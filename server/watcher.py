"""Vault file watcher — jarvis-os.

Watches the vault for note changes and triggers a debounced rebuild of every
piece of derived data (parse, graph, backlinks, FTS index).

Debounce contract: after a change, wait for a quiet period. Any further change
during that wait resets the timer, so a burst of rapid saves collapses into a
single rebuild once editing settles.

This is now the *primary* freshness mechanism; `main.get_state()` keeps a
per-request fingerprint check as a fallback.
"""
import asyncio
from pathlib import Path
from typing import Callable

from watchfiles import Change, awatch

from vault import VAULT_DIR

# Quiet period before rebuilding. Long enough to collapse a burst of saves,
# short enough that a single edit feels immediate.
DEBOUNCE_SECONDS = 0.3

# watchfiles' own grouping is kept small so the debounce above governs latency
# rather than stacking on top of it.
_WATCHFILES_DEBOUNCE_MS = 100
_WATCHFILES_STEP_MS = 50

# Directory names that never warrant a rebuild.
#   .git      — the vault is its own repo; git writes constantly
#   sessions  — daily/sessions/ raw transcripts
_IGNORED_DIRS = {".git", "sessions"}


def vault_filter(change: Change, path: str) -> bool:
    """Only real notes trigger rebuilds.

    Restricting to `.md` also excludes the FTS index (`*.db`, which lives in
    server/ anyway) and the `.tmp` files produced by atomic writes — either
    could otherwise cause a rebuild loop.
    """
    p = Path(path)
    if _IGNORED_DIRS.intersection(p.parts):
        return False
    return p.suffix.lower() == ".md"


async def watch_vault(
    rebuild: Callable[[], object],
    stop_event: asyncio.Event | None = None,
    vault_dir: Path = VAULT_DIR,
) -> None:
    """Watch `vault_dir` and call `rebuild` after changes settle.

    `rebuild` is synchronous and blocking (file I/O + sqlite), so it runs in a
    worker thread — the event loop stays free to serve requests throughout.
    """
    pending: asyncio.Task | None = None

    async def _rebuild_after_quiet(count: int) -> None:
        try:
            await asyncio.sleep(DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return  # superseded by a newer change; that one owns the rebuild
        await asyncio.to_thread(rebuild)
        print(f"[watcher] rebuilt derived data after {count} change(s)", flush=True)

    print(f"[watcher] watching {vault_dir}", flush=True)

    async for changes in awatch(
        vault_dir,
        watch_filter=vault_filter,
        stop_event=stop_event,
        debounce=_WATCHFILES_DEBOUNCE_MS,
        step=_WATCHFILES_STEP_MS,
    ):
        # Reset the timer: the newest batch always owns the pending rebuild.
        if pending is not None and not pending.done():
            pending.cancel()
        pending = asyncio.create_task(_rebuild_after_quiet(len(changes)))
