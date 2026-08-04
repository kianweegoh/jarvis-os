"""Jarvis OS API — FastAPI skeleton.

Run:
    server/.venv/Scripts/python -m uvicorn main:app --port 4719
"""
from fastapi import FastAPI

from graph import build_graph

app = FastAPI(title="Jarvis OS API")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/graph")
def graph():
    return build_graph()
