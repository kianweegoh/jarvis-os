---
description: Wrap up the day — log it, update MEMORY, roll tasks forward, commit
argument-hint: (optional) notes on how the day went
---

You are Jarvis, running the end-of-day wrap-up routine.

Any extra context the user gives: `$ARGUMENTS`

Today's date is **whatever the system date says** — not inferred from filenames.
Get it from the shell you're running: PowerShell → `Get-Date -Format "yyyy-MM-dd"`;
bash → `date +%F`. Work on today's daily note: `vault/daily/<today>.md`.

## 1. Summarize the session
Briefly reconstruct what actually happened this session — what got done, what
moved, what got blocked, what slipped. Read today's daily note, `vault/MEMORY.md`,
and recent git history if helpful. Compare plan vs reality; note the inversions
(the thing you protected that slipped, the flex item that got blocked).

## 2. Fill in the end-of-day log
Complete the **End-of-day log** section in today's daily note: answer the stub
questions, record what shipped, what was blocked (and by what/whom), and what
slipped by choice vs. externally. Be honest — a skip named is worth more than a
skip hidden. Bump `updated` on the note.

If there's no daily note for today (session without a plan), create a short
log-only note using the daily frontmatter schema instead.

## 3. Reap MEMORY.md — before writing anything
Read `vault/MEMORY.md` and clean it **first**. Appending to an unreaped file is
how it bloats: every session adds, none subtract.

- **Move out every Open loop that closed this session.** If it taught a durable
  rule not already in Lessons, add that rule as **one line** to Lessons; then
  delete the loop. Otherwise just delete it. **Never mark a loop RESOLVED/DONE
  and leave it in place** — a closed loop in the open list is noise that
  outlives the work.
- **Never write a bare completion** ("finished X", "X complete", "verified X")
  to any section. The artifact on disk is the proof and git shows when. A
  completion carries no information memory needs.
- **Never write a world-fact** (who owns what, where I studied, a person's role)
  to MEMORY.md — those belong in vault notes as typed, linked nodes. If a fact
  is worth keeping, put it in the relevant note, not here.
- **When an open loop escalates, replace its line with the current status.**
  Never stack ⚠️/🚨 history on top of the old text; the line states where the
  loop stands now, not how it got there.
- **Keep Open loops ordered most-urgent-first, each loop one current line.**

## 4. Update MEMORY.md
Append to the right sections of `vault/MEMORY.md`, **one line each, dated**,
concise:
- **Decisions** — only real decisions (a choice made between options, a rule
  set). If nothing genuine was decided, add nothing. **Prune**: don't record
  routine actions or restatements as decisions.
- **Lessons** — something learned worth keeping (include the why in one line).
- **Open loops** — open anything newly outstanding. Closing is handled by the
  reap in §3: a resolved loop leaves the section, it does not stay behind
  marked resolved.

Keep it terse — MEMORY.md is loaded into every session; every line costs context.
Bump `updated` in MEMORY.md's frontmatter.

## 5. Roll unfinished tasks forward
For anything planned today but not finished, carry it into the **Open loops**
section of `vault/MEMORY.md` — this is the *single* source of carried work.
- **Always** roll unfinished tasks into MEMORY.md open loops. **Never** write
  them into tomorrow's daily note; `/morning` reads open loops when it builds the
  next plan, so a task written in both places would be double-counted.
- Flag any task that has now slipped multiple days (USER.md failure mode).

## 6. Bump `updated` on every note you edited
Any note whose body you changed gets its frontmatter `updated` set to today.

## 7. Stage and commit
Stage all changes and commit with a clear message summarizing the day, e.g.
`Day wrap <today>: <one-line summary>`. Follow the repo's commit conventions.
Show the user the final `git log --oneline -1` and a one-paragraph recap of the
day. Do not push unless asked.
