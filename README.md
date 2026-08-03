# Jarvis OS

A personal AI assistant that lives on top of your own notes. Jarvis OS reads and
writes a plain-text Markdown vault, reasons over it with an agent that can call
tools, exposes everything through a FastAPI backend, and puts a React UI on top.

Everything is local-first and file-based: your knowledge lives in Markdown you
own, not in a proprietary database you can't read.

---

## The four-layer architecture

Jarvis OS is built as four cooperating layers, from the data at the bottom to
the interface at the top.

```
┌─────────────────────────────────────────────┐
│  4. React UI            (web/)                │  ← what you see
├─────────────────────────────────────────────┤
│  3. FastAPI backend     (server/)             │  ← the API
├─────────────────────────────────────────────┤
│  2. Agent + Tools       (server/tools, mcp/)  │  ← the reasoning
├─────────────────────────────────────────────┤
│  1. Markdown vault      (vault/)              │  ← the memory
└─────────────────────────────────────────────┘
```

### 1. Markdown vault — the memory

The vault is the source of truth: a folder of human-readable Markdown notes that
you fully own and can edit in any editor (Obsidian, VS Code, plain `vim`).

| Folder                | Holds                                   |
| --------------------- | --------------------------------------- |
| `vault/inbox/`        | Unsorted capture — the default drop zone |
| `vault/daily/`        | Daily notes / journal                    |
| `vault/weekly/`       | Weekly reviews and planning              |
| `vault/people/`       | Notes about people                       |
| `vault/projects/`     | Project notes and status                 |
| `vault/workflows/`    | Reusable workflow definitions            |

Because it's just Markdown, the vault stays useful even without Jarvis running —
and it's trivial to back up, version, and sync.

### 2. Agent + Tools — the reasoning

The agent turns natural-language requests into actions against the vault and the
outside world. It doesn't hard-code behavior; instead it calls **tools** — small,
well-scoped functions — to read notes, write notes, search, and reach external
services.

| Path             | Role                                                       |
| ---------------- | ---------------------------------------------------------- |
| `server/tools/`  | Tool implementations the agent can invoke                  |
| `server/mcp/`    | MCP server exposing those tools over the Model Context Protocol |

This layer is where retrieval, embeddings, and integrations (calendar, email,
etc.) plug in.

### 3. FastAPI backend — the API

A FastAPI service in `server/` ties the agent to the outside world. It handles
HTTP requests from the UI, streams the agent's responses, and orchestrates tool
calls and vault access. Supporting pieces:

| Path       | Role                                          |
| ---------- | --------------------------------------------- |
| `server/`  | FastAPI app, routes, and agent orchestration  |
| `jobs/`    | Scheduled / background jobs (e.g. daily rollups) |
| `evals/`   | Evaluations for agent and tool quality        |

### 4. React UI — the interface

A React front-end in `web/` is the chat and browsing surface: talk to Jarvis,
review its answers, and navigate the vault. It talks to the FastAPI backend over
HTTP.

---

## Repository layout

```
jarvis/
├── vault/            # Layer 1 — your Markdown knowledge base
│   ├── inbox/
│   ├── daily/
│   ├── weekly/
│   ├── people/
│   ├── projects/
│   └── workflows/
├── server/           # Layer 3 — FastAPI backend
│   ├── tools/        # Layer 2 — tool implementations
│   └── mcp/          # Layer 2 — MCP server
├── web/              # Layer 4 — React UI
├── jobs/             # Scheduled / background jobs
├── evals/            # Agent & tool evaluations
└── docs/             # Documentation
```

---

## Status

Day 1 — project scaffold. The directory structure and layers are in place; the
implementation of each layer is in progress.

## Getting started

_Coming soon._ The backend (Python/FastAPI) and UI (React/Vite) build steps will
be documented here once the scaffold is fleshed out.
