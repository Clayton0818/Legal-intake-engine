#!/usr/bin/env python3
"""Consistency checks for the intake spec.

This is spec tooling, not product code — it does not live in src/ and does not
presuppose the stack decision (c18). It answers one question: is the spec
internally coherent, or does it only look coherent?

Checks:
  1.  Every field type is a declared type.
  2.  Every field referenced by a node exists in the question bank.
  3.  Every goto / next / branch target resolves to a node or a terminal.
  4.  Every node is reachable from the entry node.
  5.  Every declared terminal is reachable.
  6.  Every terminal referenced by a node is declared.
  7.  Every rule referenced by a node is declared.
  8.  Every conditional_field is a field the node actually captures.
  9.  Every enum value used in a branch condition is legal for that field.
  10. Derived fields are never captured by a node.

Usage:  python3 validate_spec.py [spec_dir]
Exit 0 = clean, 1 = errors.
"""

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load(path: Path):
    with path.open() as fh:
        return yaml.safe_load(fh)


def main(spec_dir: Path) -> int:
    bank = load(spec_dir / "question-bank.yaml")
    flow = load(spec_dir / "intake-flow.yaml")

    fields = bank["fields"]
    declared_types = set(bank["types"])
    nodes = flow["nodes"]
    terminals = flow["terminals"]
    rules = flow.get("rules", {})
    follow_up = flow.get("follow_up", {})

    node_ids = set(nodes)
    terminal_ids = set(terminals)
    targets = node_ids | terminal_ids

    overlap = node_ids & terminal_ids
    if overlap:
        err(f"ids used as both node and terminal: {sorted(overlap)}")

    # 1. field types
    for fid, f in fields.items():
        t = f.get("type")
        if t not in declared_types:
            err(f"field '{fid}': undeclared type '{t}'")
        if t in ("enum", "enum_multi") and not f.get("values"):
            err(f"field '{fid}': enum without values")

    # collect every target reference, with provenance for good error messages
    def refs_of(node_id: str, node: dict):
        out = []
        for key in ("next", "goto", "on_fail", "on_decline", "default"):
            if key in node and isinstance(node[key], str):
                out.append((f"{node_id}.{key}", node[key]))
        for i, b in enumerate(node.get("branches", []) or []):
            if "goto" in b:
                out.append((f"{node_id}.branches[{i}].goto", b["goto"]))
        for k, v in (node.get("outcomes", {}) or {}).items():
            out.append((f"{node_id}.outcomes.{k}", v))
        return out

    edges: dict[str, set] = {n: set() for n in node_ids}

    for nid, node in nodes.items():
        # 2. fields exist, 10. derived not captured
        for fid in (node.get("fields") or []):
            if fid not in fields:
                err(f"node '{nid}': unknown field '{fid}'")
            elif fields[fid].get("derived") and node.get("type") == "capture":
                err(f"node '{nid}': captures derived field '{fid}'")

        # 8. conditional_fields must be captured by this node
        for fid in (node.get("conditional_fields") or {}):
            if fid not in (node.get("fields") or []):
                err(f"node '{nid}': conditional_field '{fid}' is not captured by this node")

        # 3. targets resolve
        for where, target in refs_of(nid, node):
            if target not in targets:
                err(f"{where}: unresolved target '{target}'")
            elif target in node_ids:
                edges[nid].add(target)

        # 7. rules declared
        rule = node.get("rule")
        if rule and rule not in rules:
            err(f"node '{nid}': undeclared rule '{rule}'")
        for d in (node.get("disqualify") or []):
            r = d.get("rule")
            if r not in rules:
                err(f"node '{nid}': undeclared disqualify rule '{r}'")

        # writes must be real fields
        for fid in (node.get("writes") or []):
            if fid not in fields:
                err(f"node '{nid}': writes unknown field '{fid}'")

        # 9. enum values in conditions
        conditions = [b.get("when", "") for b in (node.get("branches") or [])]
        conditions += [node.get("skip_when", "")]
        for cond in filter(None, conditions):
            check_condition(cond, fields, f"node '{nid}'")

    # disqualify rules must name a real terminal and field
    for rid, rule in rules.items():
        tgt = rule.get("on_fail")
        if tgt and tgt not in targets:
            err(f"rule '{rid}': on_fail '{tgt}' does not resolve")
        fid = rule.get("field")
        if fid and fid not in fields:
            err(f"rule '{rid}': unknown field '{fid}'")

    # terminals' follow_up must be declared (or 'none')
    for tid, t in terminals.items():
        fu = t.get("follow_up")
        if fu and fu != "none" and fu not in follow_up:
            err(f"terminal '{tid}': undeclared follow_up '{fu}'")

    # 4. reachability from entry
    entry = flow["entry"]
    if entry not in node_ids:
        err(f"entry '{entry}' is not a node")
        return report()

    seen = set()
    stack = [entry]
    reached_terminals = set()
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        for _, target in refs_of(nid, nodes[nid]):
            if target in terminal_ids:
                reached_terminals.add(target)
            elif target in node_ids:
                stack.append(target)
        for d in (nodes[nid].get("disqualify") or []):
            t = rules.get(d.get("rule"), {}).get("on_fail")
            if t in terminal_ids:
                reached_terminals.add(t)

    orphans = node_ids - seen
    if orphans:
        err(f"unreachable nodes: {sorted(orphans)}")

    # 5. terminals reachable
    unreached = terminal_ids - reached_terminals
    # abandoned is reachable by caller disengagement, not by an edge
    unreached.discard("abandoned")
    if unreached:
        warn(f"terminals never reached by any edge: {sorted(unreached)}")

    # dead-end nodes
    for nid, node in nodes.items():
        if not refs_of(nid, node):
            err(f"node '{nid}': no outgoing target (dead end)")

    print(f"  nodes: {len(node_ids)}   terminals: {len(terminal_ids)}   "
          f"fields: {len(fields)}   rules: {len(rules)}")
    print(f"  reachable nodes: {len(seen)}/{len(node_ids)}   "
          f"reachable terminals: {len(reached_terminals)}/{len(terminal_ids)}")
    return report()


COND_RE = re.compile(r"(\w+)\s*(==|!=|\bin\b|\bnot in\b)\s*(.+)")


def check_condition(cond: str, fields: dict, where: str) -> None:
    """Best-effort: verify field names and enum literals used in conditions."""
    for part in re.split(r"\band\b|\bor\b", cond):
        m = COND_RE.search(part.strip())
        if not m:
            continue
        name, op, rhs = m.group(1), m.group(2), m.group(3).strip()
        if name not in fields:
            # may be a helper call like prior_initial_meeting(...)
            if "(" not in part:
                warn(f"{where}: condition references unknown field '{name}'")
            continue
        f = fields[name]
        if f.get("type") not in ("enum", "enum_multi"):
            continue
        literals = re.findall(r"'([^']+)'", rhs)
        for lit in literals:
            if lit not in f["values"]:
                err(f"{where}: '{lit}' is not a legal value for enum '{name}' "
                    f"(allowed: {f['values']})")


def report() -> int:
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}")
    if errors:
        print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"\nOK — spec is internally consistent ({len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    d = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    sys.exit(main(d))
