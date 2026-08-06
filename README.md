# Jarvis OS

A local-first personal AI assistant built on a markdown knowledge vault — with a FastAPI backend, a knowledge-graph API, full-text search, and (in progress) an agent loop and web UI.

The design premise: **you don't build the intelligence, you build the environment the intelligence lives in.** The language model is rented from a provider; what makes the assistant *yours* is everything around it — the memory architecture, the tool integrations, the context you feed it, and the safety boundaries you put in place. This repo is that surrounding system.

> **Status:** In active development (Week 3 of a structured 12-week build). The memory layer, Google integrations, and backend read/write API are working; the agent loop, web UI, and knowledge-graph visualization are in progress. Roadmap below.

---

## Architecture

The system is four layers, each depending on the one beneath it:

```
┌──────────────────────────────────────────────────────────┐
│  LAYER 4 — INTERFACE (in progress)                       │
│  React + Vite · knowledge graph · streaming chat · HUD   │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────┐
│  LAYER 3 — BACKEND API — FastAPI                         │
│  /graph · /notes · /search · (chat, jobs to come)        │
│  Owns credentials · never exposed to the browser         │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│  LAYER 2 — AGENT + TOOLS (in progress)                   │
│  Claude Agent SDK · MCP servers · read-only integrations │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│  LAYER 1 — MEMORY — the vault                            │
│  markdown + YAML frontmatter · [[wikilinks]] · daily logs│
└──────────────────────────────────────────────────────────┘
```

**Layer 1 is the product; layers 2–4 are how you reach it.** The memory is plain markdown — human-readable, version-controllable, no proprietary database and no lock-in. Every note carries YAML frontmatter (`type`, `tags`, `status`) and `[[wikilinks]]`, which is what turns a folder of notes into a queryable, navigable graph.

---

## What's built

**Memory & context layer.** A markdown vault where each note is typed and interlinked. Standing instruction files and a working-memory file are injected into the model's context at the start of each session, so the assistant wakes up with continuity — without any change to the underlying model. This is context engineering: the system gets more useful as the vault gets richer, not because the model changes.

**Google integrations (read-only).** Calendar and Gmail wrappers using OAuth 2.0, built on a **credential-boundary pattern**: the model never sees API keys or tokens. It invokes a script by name; the script reads credentials from a git-ignored location, calls the API, and returns only results. Secrets and the model's context never occupy the same space. Scopes are deliberately read-only — capability is granted incrementally, not all at once.

**Backend API (FastAPI).** A vault parser turns markdown into structured note objects (frontmatter + extracted wikilinks). On top of it:
- `GET /api/graph` — the vault as nodes and edges, with node size by connection count and broken links reported rather than silently dropped.
- `GET /api/notes` / `GET /api/notes/{id}` — note listing (filterable by type/tag) and single-note retrieval, including **backlinks** (computed by inverting the forward-link index).
- `PUT /api/notes/{id}` — a **safe write path**: content is validated before writing, writes are atomic (temp-file + replace, so a crash can't truncate a note), and the whole vault is version-controlled as the recovery net.
- `GET /api/search?q=` — full-text search over titles, bodies, and tags via SQLite FTS5, with relevance ranking (title matches weighted above body matches) and the index rebuilt when the vault changes.

**Caching & freshness.** The parse, backlink index, and search index are computed once and reused, invalidated by a file-fingerprint check so external edits are picked up without re-parsing on every request.

---

## Design principles

A few ideas run through the whole system:

- **Least privilege.** Every tool gets the narrowest capability it needs and nothing more — read-only scopes, per-tool credentials, secrets isolated from the model.
- **Report, don't fix.** The read/parse layer surfaces problems (broken links, stale notes, malformed frontmatter) rather than silently correcting or hiding them.
- **Validation isn't correctness.** A write can be perfectly valid and still destroy data. Syntax checks catch malformed writes; version control is the only thing that catches valid-but-wrong ones — so every write path is recoverable, not just validated.
- **Earned autonomy.** The assistant is read-only first; write and send capabilities are added later, gated behind explicit confirmation. Nothing acts on the outside world automatically.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| Agent | Claude Agent SDK *(in progress)* |
| Memory | Markdown + YAML frontmatter, `[[wikilinks]]` |
| Search | SQLite FTS5 |
| Integrations | Google Calendar & Gmail APIs, OAuth 2.0 |
| Frontend | React + Vite + TypeScript *(in progress)* |
| Graph | react-force-graph *(in progress)* |

---

## Roadmap

- [x] Memory & context architecture (typed, linked markdown vault)
- [x] Session continuity via context injection
- [x] Google Calendar + Gmail integration (read-only, OAuth)
- [x] Morning-brief workflow (assembles live calendar + mail + open tasks)
- [x] Inbox ingestion (raw files → typed, linked notes)
- [x] Backend API — parser, graph, notes, search
- [ ] Agent loop (Claude Agent SDK) with streaming
- [ ] React web UI — dashboard, note viewer, chat
- [ ] Force-directed knowledge-graph visualization
- [ ] Custom MCP servers
- [ ] Tiered memory + semantic (vector) retrieval
- [ ] 24/7 deployment (VPS, scheduled jobs)

---

## Notes

This is a personal learning project, and the learning is the point. I'm building Jarvis to work through the entire modern applied-AI stack hands-on — agents, tool use, MCP, memory systems, and context engineering — by actually building each piece rather than reading about it. I learn best by building: I'd rather turn an idea into something real than theorize about how it might work.

It's also a tool I genuinely use. I've juggled multiple jobs, and managing many tasks across them is hard for me — planning time, tracking what's owed, doing repetitive work by hand. Jarvis is my attempt to offload that: to automate what shouldn't need manual effort so I can move faster and keep more attention on the work that matters. The goal isn't a chatbot I talk to — it's an assistant that already knows my context and acts on it, more collaborator than tool.

The personal knowledge vault itself is kept private; this repository contains the system, not its contents.
