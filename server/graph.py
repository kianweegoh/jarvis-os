"""Graph builder — jarvis-os.

Turns the parsed vault into force-graph data: nodes, links, and a separate
list of links that pointed nowhere.

Read-only, and report-don't-fix: a broken link produces no edge and is
reported instead of being silently dropped (same contract as vault.py).

Run:
    server/.venv/Scripts/python graph.py
"""
from vault import Note, parse_vault


def build_graph(notes: list[Note] | None = None) -> dict:
    """{nodes, links, broken_links} from the vault.

    Link targets resolve case-insensitively ([[Claude]] finds `id: claude`);
    anything that still doesn't match a real note is reported as broken.
    """
    if notes is None:
        notes = parse_vault()

    # Case-insensitive lookup, mapping back to each note's canonical id so
    # edges always reference the real id rather than however it was typed.
    by_lower = {note.id.lower(): note.id for note in notes}

    links: list[dict] = []
    broken_links: list[dict] = []

    for note in notes:
        for target in note.links:
            resolved = by_lower.get(target.lower())
            if resolved is None:
                broken_links.append({"source": note.id, "target": target})
                continue
            links.append({"source": note.id, "target": resolved})

    # val = connection count: every edge touching a node counts, whether the
    # node is the source or the target.
    counts = {note.id: 0 for note in notes}
    for link in links:
        counts[link["source"]] += 1
        counts[link["target"]] += 1

    nodes = [
        {
            "id": note.id,
            "label": note.title or note.id,
            "type": note.type,
            "tags": note.tags,
            "val": counts[note.id],
        }
        for note in notes
    ]

    return {"nodes": nodes, "links": links, "broken_links": broken_links}


if __name__ == "__main__":
    graph = build_graph()

    print(f"Nodes: {len(graph['nodes'])}")
    print(f"Links: {len(graph['links'])}")
    print(f"Broken links: {len(graph['broken_links'])}")

    print("\nMost connected:")
    for node in sorted(graph["nodes"], key=lambda n: -n["val"])[:10]:
        print(f"  {node['val']:>3}  {node['id']}")

    if graph["broken_links"]:
        print("\nBroken:")
        for link in graph["broken_links"]:
            print(f"  [[{link['target']}]]  <- {link['source']}")
