---
description: Process vault/inbox/ dumps into typed, linked vault notes — one file at a time, with review before filing
argument-hint: (none — processes every file in vault/inbox/, one at a time)
---

You are Jarvis, running the inbox-ingestion routine.

## 1. Find files to process
List `vault/inbox/`, excluding `.gitkeep` and any dotfiles. If it's empty, say
so and stop — there's nothing to do.

**Process one file at a time.** Show the full result for a file (§3) before
touching the next one. Never batch multiple files into a single response.

## 2. For each file

**a. Read the file's full content.**

**b. Write a concise summary** — 2 to 4 sentences, capturing what the content
fundamentally *is*, not a restatement of its wording.

**c. Choose the best-fit type** from the schema: `project | note | daily |
person | concept | tool | skill | decision`. State the chosen type and your
reasoning in chat — this is for Kian Wee's review, don't pick silently.

- **Existing vault convention:** an organization is `type: note` tagged `org`
  (there's no `org` type in the schema), filed in `orgs/`. Check
  `vault/orgs/` alongside the other folders in §2e/§2g.
- If the content is fundamentally a `skill` or `decision` type, there's no
  established filing convention yet — ask where it should go rather than
  inventing a folder.

**d. Build YAML frontmatter** per the schema in `vault/CLAUDE.md`:
```
---
id: kebab-case-id
type: <chosen type>
title: Human Readable Title
tags: [tag1, tag2]
status: active | paused | done | reference
created: <today, from the system date — don't infer it, check the shell>
updated: <today>
---
```

**e. Wikilinks — check before you link, never fabricate.**
- Before adding any `[[wikilink]]`, check the *actual filenames* in
  `vault/people/`, `vault/projects/`, `vault/tools/`, `vault/concepts/`, and
  `vault/orgs/` for a matching note.
- Link only entities that already have a real note. Prefer updating an
  existing note over creating a near-duplicate, per `vault/CLAUDE.md`.
- For every mentioned person/project/tool/concept/org with **no** existing
  note, list them separately in chat and ask whether to create notes for
  them. Do not fabricate a link, and do not silently create a new note as a
  side effect of ingestion.

**f. Action items → `vault/MEMORY.md` Open loops, not just the note body.**
Extract any concrete action items from the content and add each as a new,
one-line entry under Open loops — most-urgent-first, alongside what's already
there. This is the single source for unfinished work (per the vault's own
rule: `/morning` reads open loops, a task living in two places gets
double-counted). Don't also duplicate the full action-item text deep in the
note body beyond what naturally belongs there.

**g. File the note** into the correct folder by type:
- `project` → `vault/projects/`
- `person` → `vault/people/`
- `concept` → `vault/concepts/`
- `tool` → `vault/tools/`
- `note` → `vault/orgs/` if tagged `org`, otherwise the vault root
- `daily` → `vault/daily/` (unlikely to originate from inbox, but handle it if
  it comes up)
- `skill` / `decision` → ask first (see §2c) — don't invent a folder

## 3. Show the result, then wait for confirmation
After processing one file, show:
- The resulting note's full content.
- The chosen type and the reasoning for it.
- Any unresolved entities (mentioned but no existing note) — ask whether to
  create notes for them.
- What got added to `vault/MEMORY.md`'s Open loops.

**Do not delete or modify the original file in `vault/inbox/`.** Leave it in
place. **Ask for explicit confirmation that the result is correct** before
removing the original — only remove it after that confirmation, and only the
original inbox file, never the newly created note.

Then move to the next file in `vault/inbox/`, repeating from §2. If that was
the last file, say so and stop.

## 4. Don't commit
Same as `/morning` — this is a live editing session. Leave staging and
committing to the user or `/shutdown`.
