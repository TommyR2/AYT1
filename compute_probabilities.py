#!/usr/bin/env python3
"""
compute_probabilities.py (robust)

Reads all ceremony_data/week_*.json and truth_booth_data/booth_*.json,
applies truth-booth and beam constraints, enumerates all consistent perfect
matchings, and writes data.json with pairwise probabilities.

Usage:
  python compute_probabilities.py \
      --ceremony_dir ceremony_data \
      --truth_booth_dir truth_booth_data \
      --output data.json \
      [--allow_comments] [--verbose]
"""
import argparse, json, os, re, sys
from dataclasses import dataclass
from typing import List, Dict

# ---------- helpers ----------

def natural_key(path: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', str(path))]

def _strip_bom_and_ws(s: str) -> str:
    return s.lstrip("\ufeff").strip()

def _decomment(s: str) -> str:
    # remove // line comments and /* block comments */
    s = re.sub(r"//[^\n\r]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return s

def read_json_file(path: str, allow_comments: bool):
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    cleaned = _strip_bom_and_ws(raw)
    if not cleaned:
        raise ValueError("file is empty")
    if allow_comments:
        cleaned = _decomment(cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        # show a more actionable error with context
        msg = f"Invalid JSON in {path}: {e.msg} at line {e.lineno} col {e.colno}"
        raise ValueError(msg) from e

def load_json_files(folder: str, pattern: str, *, allow_comments: bool, verbose: bool):
    if not folder or not os.path.isdir(folder):
        return []
    pat = re.compile(pattern, re.IGNORECASE)
    files = sorted([f for f in os.listdir(folder) if pat.fullmatch(f)], key=natural_key)
    objs = []
    for fname in files:
        path = os.path.join(folder, fname)
        if verbose:
            print(f"[load] {path}")
        try:
            objs.append((path, read_json_file(path, allow_comments)))
        except Exception as e:
            # stop immediately with the precise filename and reason
            raise SystemExit(f"[ERROR] {e}")
    return objs

def parse_truth_result(val) -> str:
    if isinstance(val, str):
        v = val.strip().lower()
        if v in ("match", "true", "yes", "1"): return "match"
        if v in ("no match", "nomatch", "false", "no", "0"): return "no match"
    if isinstance(val, (int, bool)):
        return "match" if bool(val) else "no match"
    raise ValueError(f"Unrecognized truth booth result: {val!r}")

def popcount(x: int) -> int:
    return x.bit_count() if hasattr(int, "bit_count") else bin(x).count("1")

# ---------- data shapes ----------

@dataclass
class Ceremony:
    matchups: List[List[int]]
    beams: int

@dataclass
class Problem:
    men: List[str]
    women: List[str]
    ceremonies: List[Ceremony]
    allowed: List[int]          # bitmask per man
    forced_pairs: Dict[int, int]  # man_i -> woman_j

# ---------- build the problem ----------

def build_problem(ceremony_objs, truth_objs) -> Problem:
    men = women = None
    ceremonies: List[Ceremony] = []

    for path, obj in ceremony_objs:
        m = obj.get("men"); w = obj.get("women")
        mat = obj.get("matchups"); beams = obj.get("result")
        if m is None or w is None or mat is None or beams is None:
            raise SystemExit(f"[ERROR] {path}: must contain men, women, matchups, result")
        if men is None: men = m
        if women is None: women = w
        if m != men or w != women:
            raise SystemExit(f"[ERROR] {path}: men/women differ from earlier ceremony file(s)")
        n = len(men)
        if len(mat) != n or any(len(row) != n for row in mat):
            raise SystemExit(f"[ERROR] {path}: matchups must be {n}x{n}")
        ceremonies.append(Ceremony(matchups=[list(map(int, row)) for row in mat],
                                   beams=int(beams)))

    if men is None or women is None:
        raise SystemExit("[ERROR] Need at least one ceremony file (with men/women) to define roster.")

    n = len(men)
    allowed = [(1 << n) - 1 for _ in range(n)]
    name_to_man = {name: i for i, name in enumerate(men)}
    name_to_woman = {name: j for j, name in enumerate(women)}
    forced_pairs: Dict[int, int] = {}

    for path, obj in truth_objs:
        man = obj.get("man"); woman = obj.get("woman")
        if man not in name_to_man or woman not in name_to_woman:
            raise SystemExit(f"[ERROR] {path}: unknown names {man!r}, {woman!r}")
        i = name_to_man[man]; j = name_to_woman[woman]
        res = parse_truth_result(obj.get("result"))
        if res == "no match":
            allowed[i] &= ~(1 << j)
        else:
            if i in forced_pairs and forced_pairs[i] != j:
                raise SystemExit(f"[ERROR] Conflicting forced matches for {man}")
            forced_pairs[i] = j

    # apply forced pairs
    for i, j in list(forced_pairs.items()):
        if (allowed[i] & (1 << j)) == 0:
            raise SystemExit(f"[ERROR] Forced pair {men[i]}–{women[j]} contradicts a 'no match'")
        allowed[i] = (1 << j)
        for ii in range(n):
            if ii != i:
                allowed[ii] &= ~(1 << j)
        for ii, jj in list(forced_pairs.items()):
            if ii != i and jj == j:
                raise SystemExit(f"[ERROR] Two forced pairs use woman {women[j]}")

    for i in range(n):
        if allowed[i] == 0:
            raise SystemExit(f"[ERROR] No allowed options remain for {men[i]} after truth-booth constraints")

    return Problem(men, women, ceremonies, allowed, forced_pairs)

# ---------- exact enumeration with pruning ----------

def enumerate_consistent_matchings(problem: Problem):
    men, women = problem.men, problem.women
    n = len(men)

    C = []
    beams = []
    for cer in problem.ceremonies:
        row_masks = []
        for i in range(n):
            mask = 0
            for j, val in enumerate(cer.matchups[i]):
                if val: mask |= (1 << j)
            row_masks.append(mask)
        C.append(row_masks)
        beams.append(cer.beams)

    allowed = problem.allowed[:]
    assignment = [-1] * n
    taken_mask = 0

    for i, j in problem.forced_pairs.items():
        if (taken_mask >> j) & 1:
            raise SystemExit(f"[ERROR] Woman {women[j]} already taken by another forced pair")
        assignment[i] = j
        taken_mask |= (1 << j)

    sofar = [0] * len(C)
    for k, row_masks in enumerate(C):
        cnt = 0
        for i in range(n):
            j = assignment[i]
            if j != -1 and ((row_masks[i] >> j) & 1):
                cnt += 1
        sofar[k] = cnt
        if sofar[k] > beams[k]:
            return 0, [[0] * n for _ in range(n)]  # impossible already

    order = list(range(n))
    def domain_size(i): return 1 if assignment[i] != -1 else popcount(allowed[i] & ~taken_mask)
    order.sort(key=domain_size)

    total = 0
    pair_counts = [[0] * n for _ in range(n)]

    def ub_additional(k, avail_mask, unassigned_men):
        ub = 0; row_masks = C[k]
        for i in unassigned_men:
            if (row_masks[i] & allowed[i] & avail_mask) != 0:
                ub += 1
        return ub

    def dfs(idx, taken_mask, sofar, unassigned_men):
        nonlocal total, pair_counts
        if idx == len(order):
            for k in range(len(C)):
                if sofar[k] != beams[k]: return
            total += 1
            for i in range(n):
                pair_counts[i][assignment[i]] += 1
            return

        i = order[idx]
        if assignment[i] != -1:
            avail_mask = ~taken_mask & ((1 << n) - 1)
            for k in range(len(C)):
                if sofar[k] > beams[k]: return
                if sofar[k] + ub_additional(k, avail_mask, [ii for ii in unassigned_men if assignment[ii] == -1]) < beams[k]:
                    return
            dfs(idx + 1, taken_mask, sofar, unassigned_men)
            return

        candidates_mask = allowed[i] & (~taken_mask)
        if candidates_mask == 0: return
        cand_js = [j for j in range(n) if (candidates_mask >> j) & 1]

        def score(j):
            hits = sum(1 for k in range(len(C)) if (C[k][i] >> j) & 1)
            fanout = sum(1 for ii in unassigned_men if assignment[ii] == -1 and ((allowed[ii] >> j) & 1))
            return (-hits, fanout)
        cand_js.sort(key=score)

        for j in cand_js:
            inc = [0] * len(C); ok = True
            for k in range(len(C)):
                if (C[k][i] >> j) & 1:
                    inc[k] = 1
                    if sofar[k] + 1 > beams[k]: ok = False; break
            if not ok: continue

            next_taken = taken_mask | (1 << j)
            avail_mask = ~next_taken & ((1 << n) - 1)
            for k in range(len(C)):
                if sofar[k] + inc[k] + ub_additional(k, avail_mask, [ii for ii in unassigned_men if assignment[ii] == -1 and ii != i]) < beams[k]:
                    ok = False; break
            if not ok: continue

            assignment[i] = j
            for k in range(len(C)): sofar[k] += inc[k]
            dfs(idx + 1, next_taken, sofar, unassigned_men)
            for k in range(len(C)): sofar[k] -= inc[k]
            assignment[i] = -1

    unassigned = [i for i in range(n) if assignment[i] == -1]
    dfs(0, taken_mask, sofar[:], unassigned)
    return total, pair_counts

# ---------- public API ----------

def compute_probabilities(ceremony_dir: str, truth_dir: str, out_path: str, *, allow_comments: bool, verbose: bool):
    ceremony_objs = load_json_files(ceremony_dir, r"week_.*\.json", allow_comments=allow_comments, verbose=verbose)
    truth_objs    = load_json_files(truth_dir,    r"booth_.*\.json", allow_comments=allow_comments, verbose=verbose)
    if not ceremony_objs and not truth_objs:
        raise SystemExit("[ERROR] No input files found.")
    problem = build_problem(ceremony_objs, truth_objs)
    total, counts = enumerate_consistent_matchings(problem)
    n = len(problem.men)
    probs = [[0.0] * n for _ in range(n)]
    if total > 0:
        for i in range(n):
            for j in range(n):
                probs[i][j] = counts[i][j] / total
    else:
        print("[ERROR] No consistent matchings exist; writing zeros.", file=sys.stderr)
    out = {"men": problem.men, "women": problem.women, "probabilities": probs}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    return out_path, total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ceremony_dir", default="ceremony_data")
    ap.add_argument("--truth_booth_dir", default="truth_booth_data")
    ap.add_argument("--output", default="data.json")
    ap.add_argument("--allow_comments", action="store_true", help="Allow // and /* */ comments in JSON files")
    ap.add_argument("--verbose", action="store_true", help="List files as they are read")
    args = ap.parse_args()
    out_path, total = compute_probabilities(args.ceremony_dir, args.truth_booth_dir, args.output,
                                            allow_comments=args.allow_comments, verbose=args.verbose)
    print(f"Wrote {out_path} (solutions counted: {total})")

if __name__ == "__main__":
    main()
