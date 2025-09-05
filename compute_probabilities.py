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

# --- add near the other imports ---
import math


def roster_from_ceremony_obj(obj, allow_from_matches=False):
    """
    Return (men, women) for the roster.
    - If arrays are present, use them.
    - If allow_from_matches=True and arrays are absent, derive from 'matches' order.
    - Otherwise return (None, None).
    """
    men = obj.get("men")
    women = obj.get("women")
    if men and women:
        return men, women

    if allow_from_matches and isinstance(obj.get("matches"), list):
        men_list, women_list = [], []
        for pair in obj["matches"]:
            man = (pair.get("man") or "").strip()
            woman = (pair.get("woman") or "").strip()
            if man and man not in men_list:
                men_list.append(man)
            if woman and woman not in women_list:
                women_list.append(woman)
        if men_list and women_list:
            return men_list, women_list

    return None, None

def matchups_from_ceremony_obj(obj, men, women):
    """
    Produce an n×n 0/1 matrix from either:
      - old format: 'matchups'
      - new format: 'matches' list
    """
    n = len(men)
    beams = obj.get("result")
    if beams is None:
        raise SystemExit("[ERROR] ceremony missing 'result'")

    if "matchups" in obj:
        mat = obj["matchups"]
        if len(mat) != n or any(len(row) != n for row in mat):
            raise SystemExit(f"[ERROR] ceremony matchups must be {n}x{n}")
        return [list(map(int, row)) for row in mat], int(beams)

    if "matches" in obj and isinstance(obj["matches"], list):
        name_to_man = {name: i for i, name in enumerate(men)}
        name_to_woman = {name: j for j, name in enumerate(women)}
        mat = [[0] * n for _ in range(n)]
        for pair in obj["matches"]:
            mi = name_to_man.get((pair.get("man") or "").strip())
            wj = name_to_woman.get((pair.get("woman") or "").strip())
            if mi is None or wj is None:
                raise SystemExit(f"[ERROR] unknown name in matches: {pair!r}")
            mat[mi][wj] = 1
        return mat, int(beams)

    raise SystemExit("[ERROR] ceremony must contain either 'matchups' or 'matches']")

# --- helper: pull week index from filenames like "week_2.json", "booth_03.json" ---
def _week_of(path: str) -> int:
    m = re.search(r'(\d+)', os.path.basename(path))
    return int(m.group(1)) if m else math.inf

def _filter_upto_week(pairs, week: int):
    """pairs is list[(path,obj)]. Keep those whose filename week <= given week."""
    return [(p, o) for (p, o) in pairs if _week_of(p) <= week]

# --- refactor the single-run writer into a tiny helper we can reuse ---
def _write_probabilities(problem, out_path):
    total, counts = enumerate_consistent_matchings(problem)
    n = len(problem.men)
    probs = [[0.0] * n for _ in range(n)]
    if total > 0:
        for i in range(n):
            for j in range(n):
                # keep your current output orientation
                probs[i][j] = counts[i][j] / total
    else:
        print("[ERROR] No consistent matchings exist; writing zeros.", file=sys.stderr)
    out = {"men": problem.men, "women": problem.women, "probabilities": probs}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    return out_path, total

# --- new: split-by-week driver ---
def compute_probabilities_split_weeks(ceremony_dir: str, truth_dir: str, out_prefix: str, *,
                                      allow_comments: bool, verbose: bool):
    # Load everything once
    ceremony_objs = load_json_files(ceremony_dir, r"week_.*\.json", allow_comments=allow_comments, verbose=verbose)
    truth_objs    = load_json_files(truth_dir,    r"booth_.*\.json", allow_comments=allow_comments, verbose=verbose)
    if not ceremony_objs:
        raise SystemExit("[ERROR] No ceremony files found (needed for roster).")

    first_path, first_obj = sorted(ceremony_objs, key=lambda t: _week_of(t[0]))[0]
    men, women = roster_from_ceremony_obj(first_obj, allow_from_matches=True)
    if not men or not women:
        raise SystemExit(f"[ERROR] {first_path} missing roster (and no 'matches' to infer it).")

    max_week = max((_week_of(p) for (p, _) in ceremony_objs if _week_of(p) != math.inf), default=0)

    written = []
    for w in range(0, max_week + 1):
        # ceremonies/truth up to and including week w
        cer_upto_w = _filter_upto_week(ceremony_objs, w)
        tb_upto_w  = _filter_upto_week(truth_objs, w)

        if w == 0:
            # Build problem with NO ceremony constraints (uniform unless truth booths exist for week 0)
            # We still need allowed/forced from truth booths (if any)
            # Reuse build_problem to apply truth booths, then drop ceremonies.
            prob = build_problem([ (first_path, first_obj) ], tb_upto_w)
            prob.ceremonies = []  # remove constraints → week 0 becomes “equal for everyone” if no TBs
        else:
            prob = build_problem(cer_upto_w, tb_upto_w)

        out_path = f"{out_prefix}_week_{w}.json"
        _, total = _write_probabilities(prob, out_path)
        if verbose:
            print(f"[split] Wrote {out_path} (solutions counted: {total})")
        written.append(out_path)
    return written

def compute_probabilities_for_week(ceremony_dir: str, truth_dir: str, out_prefix: str, week: int, *,
                                   allow_comments: bool, verbose: bool):
    # Load once
    ceremony_objs = load_json_files(ceremony_dir, r"week_.*\.json", allow_comments=allow_comments, verbose=verbose)
    truth_objs    = load_json_files(truth_dir,    r"booth_.*\.json", allow_comments=allow_comments, verbose=verbose)
    if not ceremony_objs:
        raise SystemExit("[ERROR] No ceremony files found (needed for roster).")

    # Determine available week range
    finite_weeks = [ _week_of(p) for (p, _) in ceremony_objs if _week_of(p) != math.inf ]
    max_week = max(finite_weeks) if finite_weeks else 0  # should exist since ceremony_objs non-empty

    if week < 0:
        raise SystemExit(f"[ERROR] --split_week must be >= 0 (got {week})")
    if week > max_week:
        avail = ", ".join(map(str, sorted(set(finite_weeks)))) or "none"
        raise SystemExit(
            f"[ERROR] Requested week {week} exceeds max available week {max_week}.\n"
            f"Available ceremony weeks: {avail}"
        )

    # Fix roster from earliest ceremony (supports matches- or matrix-format)
    first_path, first_obj = sorted(ceremony_objs, key=lambda t: _week_of(t[0]))[0]
    men, women = roster_from_ceremony_obj(first_obj, allow_from_matches=True)
    if not men or not women:
        raise SystemExit(f"[ERROR] {first_path} missing roster (and no 'matches' to infer it).")

    # Keep only files with filename week <= requested week
    cer_upto = _filter_upto_week(ceremony_objs, week)
    tb_upto  = _filter_upto_week(truth_objs, week)

    # Week 0 = truth booths only (remove ceremony constraints after using first file to define roster)
    if week == 0:
        prob = build_problem([(first_path, first_obj)], tb_upto)
        prob.ceremonies = []
    else:
        prob = build_problem(cer_upto, tb_upto)

    out_path = f"{out_prefix}_week_{week}.json"
    _, total = _write_probabilities(prob, out_path)
    if verbose:
        print(f"[split] Wrote {out_path} (solutions counted: {total})")
    return out_path


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

    # Ensure ceremonies are processed in filename order (week_1, week_2, ...)
    ceremony_objs = sorted(ceremony_objs, key=lambda t: natural_key(t[0]))

    for idx, (path, obj) in enumerate(ceremony_objs):
        # For the very first ceremony, establish the roster
        if idx == 0 and (men is None and women is None):
            cm, cw = roster_from_ceremony_obj(obj, allow_from_matches=True)
            if not cm or not cw:
                raise SystemExit(f"[ERROR] {path}: cannot infer men/women roster")
            men, women = cm, cw
        else:
            # If this file explicitly declares arrays, they must match the established roster
            cm, cw = roster_from_ceremony_obj(obj, allow_from_matches=False)
            if cm and cw and (cm != men or cw != women):
                raise SystemExit(f"[ERROR] {path}: men/women differ from earlier ceremony file(s)")

        # Build the matrix from either format using the fixed roster
        mat, beams = matchups_from_ceremony_obj(obj, men, women)

        n = len(men)
        if len(mat) != n or any(len(row) != n for row in mat):
            raise SystemExit(f"[ERROR] {path}: matchups must be {n}x{n}")
        ceremonies.append(Ceremony(matchups=mat, beams=int(beams)))

    if men is None or women is None:
        raise SystemExit("[ERROR] Need at least one ceremony to define the roster.")

    # Truth booths → allowed/forced (unchanged except for .strip())
    n = len(men)
    allowed = [(1 << n) - 1 for _ in range(n)]
    name_to_man = {name: i for i, name in enumerate(men)}
    name_to_woman = {name: j for j, name in enumerate(women)}
    forced_pairs: Dict[int, int] = {}

    for path, obj in truth_objs:
        man = (obj.get("man") or "").strip()
        woman = (obj.get("woman") or "").strip()
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

    # Apply forced pairs (unchanged)
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
    ap.add_argument("--split_weeks", action="store_true",
                    help="Emit data_week_{k}.json for k=0..max_week using ceremonies/truth up to week k")
    ap.add_argument("--split_week", type=int,
                help="Compute probabilities using all data up to this week only (writes <base>_week_<k>.json)")

    args = ap.parse_args()

    if args.split_week is not None:
        base, _ = os.path.splitext(args.output)
        compute_probabilities_for_week(args.ceremony_dir, args.truth_booth_dir, base, args.split_week,
                                    allow_comments=args.allow_comments, verbose=args.verbose)
    elif args.split_weeks:
        base, _ = os.path.splitext(args.output)
        written = compute_probabilities_split_weeks(args.ceremony_dir, args.truth_booth_dir, base,
                                                    allow_comments=args.allow_comments, verbose=args.verbose)
        print("Wrote:", ", ".join(written))
    else:
        out_path, total = compute_probabilities(args.ceremony_dir, args.truth_booth_dir, args.output,
                                                allow_comments=args.allow_comments, verbose=args.verbose)
        print(f"Wrote {out_path} (solutions counted: {total})")


if __name__ == "__main__":
    main()
