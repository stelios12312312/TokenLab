#!/usr/bin/env node
// prolog.mjs — Minimal Prolog interpreter for rule-based verification.
// Pure ES module, zero dependencies, Node.js 18+.
//
// Supports: atoms, variables, numbers, compound terms, lists,
// unification, SLD resolution with backtracking, negation-as-failure.
// Built-ins: true, fail, =, \=, \+, member/2, append/3, length/2,
// findall/3, forall/2, is/2, >=, >, <, =<, write/1, writeln/1,
// atom/1, number/1, var/1, nonvar/1, ground/1.
//
// API:
//   import { createSession } from './prolog.mjs';
//   const s = createSession();
//   s.consult('parent(tom, bob). parent(bob, ann).');
//   s.consult('ancestor(X, Y) :- parent(X, Y).');
//   s.consult('ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).');
//   for (const ans of s.query('ancestor(tom, Who)')) {
//     console.log(ans.Who); // 'bob', then 'ann'
//   }

import { readFileSync } from "fs";

// ═══════════════════════════════════════════════════════════
// Term constructors
// ═══════════════════════════════════════════════════════════

export function atom(name) { return { type: "atom", name: String(name) }; }
export function variable(name) { return { type: "var", name }; }
export function compound(functor, args) { return { type: "compound", functor, args }; }
export function num(value) { return { type: "number", value: Number(value) }; }

const NIL = Object.freeze(atom("[]"));
export { NIL };

export function list(elements, tail = NIL) {
  let r = tail;
  for (let i = elements.length - 1; i >= 0; i--) r = compound(".", [elements[i], r]);
  return r;
}

// ═══════════════════════════════════════════════════════════
// Substitution helpers
// ═══════════════════════════════════════════════════════════

function walk(term, subst) {
  while (term.type === "var" && subst.has(term.name)) term = subst.get(term.name);
  return term;
}

const MAX_DEEP_WALK_DEPTH = 200;
function deepWalk(term, subst, _depth = 0) {
  if (_depth > MAX_DEEP_WALK_DEPTH) return term; // RT4-H3: prevent stack overflow on deep/cyclic chains
  term = walk(term, subst);
  if (term.type === "compound") return compound(term.functor, term.args.map(a => deepWalk(a, subst, _depth + 1)));
  return term;
}

// ═══════════════════════════════════════════════════════════
// Unification (Robinson's algorithm with depth limit)
// No occurs check, but depth limit prevents infinite terms from causing stack overflow.
// ═══════════════════════════════════════════════════════════

const MAX_UNIFY_DEPTH = 100;
const MAX_SUBST_SIZE = 10000; // RT3-H2-FIX: Cap substitution map to prevent memory exhaustion

// RT3-H3-FIX: Occur check — returns true if varName appears anywhere in term.
// Prevents cyclic terms like X = f(X) which cause infinite loops.
function occursIn(varName, term, subst, _depth = 0) {
  if (_depth > 200) return true; // M2-FIX: Raised from 50 to 200 — prevents false positives on legitimate deep structures
  term = walk(term, subst);
  if (term.type === "var") return term.name === varName;
  if (term.type === "compound") return term.args.some(a => occursIn(varName, a, subst, _depth + 1));
  return false;
}

function unify(t1, t2, subst, _depth = 0) {
  if (_depth > MAX_UNIFY_DEPTH) return null; // Depth guard: prevents infinite terms (F-004)
  // RT3-H2-FIX: Breadth guard — prevents memory bomb via large substitution maps
  if (subst.size > MAX_SUBST_SIZE) return null;
  t1 = walk(t1, subst);
  t2 = walk(t2, subst);
  // RT3-H3-FIX: Occur check — prevent cyclic terms (X = f(X)) which cause
  // infinite loops in termToString() and list iteration.
  if (t1.type === "var") {
    if (occursIn(t1.name, t2, subst)) return null;
    return new Map(subst).set(t1.name, t2);
  }
  if (t2.type === "var") {
    if (occursIn(t2.name, t1, subst)) return null;
    return new Map(subst).set(t2.name, t1);
  }
  if (t1.type === "atom" && t2.type === "atom" && t1.name === t2.name) return subst;
  if (t1.type === "number" && t2.type === "number" && t1.value === t2.value) return subst;
  if (t1.type === "compound" && t2.type === "compound" &&
      t1.functor === t2.functor && t1.args.length === t2.args.length) {
    let s = new Map(subst);
    for (let i = 0; i < t1.args.length; i++) {
      s = unify(t1.args[i], t2.args[i], s, _depth + 1);
      if (!s) return null;
    }
    return s;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// Variable renaming (fresh copy per clause use)
// ═══════════════════════════════════════════════════════════

let _vc = 0;
function renameClause(clause) {
  const pfx = `_R${_vc++}_`;
  const map = new Map();
  function ren(t) {
    if (t.type === "var") {
      if (!map.has(t.name)) map.set(t.name, variable(pfx + t.name));
      return map.get(t.name);
    }
    if (t.type === "compound") return compound(t.functor, t.args.map(ren));
    return t;
  }
  return { head: ren(clause.head), body: clause.body.map(ren) };
}

// ═══════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════

function tokenize(src) {
  const toks = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    // Whitespace
    if (/\s/.test(src[i])) { i++; continue; }
    // Line comments
    if (src[i] === "%" ) { while (i < len && src[i] !== "\n") i++; continue; }
    // Block comments
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < len - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2; continue;
    }
    // Neck :-
    if (src[i] === ":" && src[i + 1] === "-") { toks.push(":-"); i += 2; continue; }
    // \+ (negation)
    if (src[i] === "\\" && src[i + 1] === "+") { toks.push("\\+"); i += 2; continue; }
    // \= (not unifiable)
    if (src[i] === "\\" && src[i + 1] === "=") { toks.push("\\="); i += 2; continue; }
    // =:= (arithmetic equal)
    if (src[i] === "=" && src[i + 1] === ":" && src[i + 2] === "=") { toks.push("=:="); i += 3; continue; }
    // =\= (arithmetic not equal)
    if (src[i] === "=" && src[i + 1] === "\\" && src[i + 2] === "=") { toks.push("=\\="); i += 3; continue; }
    // >= =<
    if (src[i] === ">" && src[i + 1] === "=") { toks.push(">="); i += 2; continue; }
    if (src[i] === "=" && src[i + 1] === "<") { toks.push("=<"); i += 2; continue; }
    // Single-char operators and delimiters
    // F-025 FIX: Handle negative number literals — if '-' is followed by a digit
    // and preceded by an operator/delimiter/start, treat as negative number
    if (src[i] === "-" && i + 1 < len && /[0-9]/.test(src[i + 1])) {
      const prev = toks.length > 0 ? toks[toks.length - 1] : null;
      if (prev === null || prev === "(" || prev === "," || prev === "[" || prev === "|" ||
          prev === "is" || prev === "+" || prev === "-" || prev === "*" || prev === "/" ||
          prev === ">=" || prev === "=<" || prev === ">" || prev === "<" || prev === "=:=" ||
          prev === "=\\=") {
        i++; // skip '-'
        let n = "";
        while (i < len && /[0-9]/.test(src[i])) { n += src[i]; i++; }
        toks.push({ type: "NUM", value: -parseInt(n, 10) });
        continue;
      }
    }
    if ("()[],.><=|+-*/".includes(src[i])) { toks.push(src[i]); i++; continue; }
    // Numbers
    if (/[0-9]/.test(src[i])) {
      let n = "";
      while (i < len && /[0-9]/.test(src[i])) { n += src[i]; i++; }
      toks.push({ type: "NUM", value: parseInt(n, 10) });
      continue;
    }
    // Quoted atoms
    if (src[i] === "'") {
      i++; let s = "";
      while (i < len && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < len) { i++; }
        s += src[i]; i++;
      }
      i++; // closing quote
      toks.push({ type: "ATOM", value: s });
      continue;
    }
    // Identifiers: atoms (lowercase start) and variables (uppercase / _ start)
    if (/[a-zA-Z_]/.test(src[i])) {
      let id = "";
      while (i < len && /[a-zA-Z0-9_]/.test(src[i])) { id += src[i]; i++; }
      if (id === "_") {
        toks.push({ type: "VAR", value: `_Anon${_vc++}` });
      } else if (/^[A-Z_]/.test(id)) {
        toks.push({ type: "VAR", value: id });
      } else {
        toks.push({ type: "ATOM", value: id });
      }
      continue;
    }
    i++; // skip unrecognized
  }
  return toks;
}

// ═══════════════════════════════════════════════════════════
// Parser (recursive descent)
// ═══════════════════════════════════════════════════════════

const INFIX_OPS = new Set(["=", "\\=", "is", ">=", "=<", "<", ">", "=:=", "=\\="]);
const ARITH_OPS = new Set(["+", "-", "*", "/"]);

function parse(tokens) {
  let pos = 0;
  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function advance() { return tokens[pos++]; }
  function isToken(val) {
    const t = peek();
    if (t === val) return true;
    if (t && typeof t === "object" && (t.value === val || t.type === val)) return true;
    return false;
  }
  function expect(val) {
    if (!isToken(val)) throw new Error(`Expected '${val}', got '${JSON.stringify(peek())}' at token ${pos}`);
    return advance();
  }

  // term = negation | comparison
  function parseTerm() {
    if (isToken("\\+")) { advance(); return compound("\\+", [parsePrimary()]); }
    return parseComparison();
  }

  // comparison = arithmetic (OP arithmetic)*
  function parseComparison() {
    let left = parseArithmetic();
    while (true) {
      const t = peek();
      const tv = typeof t === "string" ? t : (t && t.type === "ATOM" ? t.value : null);
      if (INFIX_OPS.has(tv)) { advance(); left = compound(tv, [left, parseArithmetic()]); }
      else break;
    }
    return left;
  }

  // arithmetic = primary ((+|-|*|/) primary)*
  function parseArithmetic() {
    let left = parsePrimary();
    while (true) {
      const t = peek();
      if (typeof t === "string" && ARITH_OPS.has(t)) { advance(); left = compound(t, [left, parsePrimary()]); }
      else break;
    }
    return left;
  }

  function parsePrimary() {
    const t = peek();
    // Parenthesized
    if (t === "(") { advance(); const term = parseTerm(); expect(")"); return term; }
    // List
    if (t === "[") {
      advance();
      if (isToken("]")) { advance(); return NIL; }
      const elems = [parseTerm()];
      while (isToken(",")) { advance(); elems.push(parseTerm()); }
      if (isToken("|")) { advance(); const tail = parseTerm(); expect("]"); return list(elems, tail); }
      expect("]");
      return list(elems);
    }
    // Number
    if (t && typeof t === "object" && t.type === "NUM") { advance(); return num(t.value); }
    // Variable
    if (t && typeof t === "object" && t.type === "VAR") { advance(); return variable(t.value); }
    // Atom (possibly compound with args)
    if (t && typeof t === "object" && t.type === "ATOM") {
      advance();
      if (isToken("(")) {
        advance();
        const args = [];
        if (!isToken(")")) { args.push(parseTerm()); while (isToken(",")) { advance(); args.push(parseTerm()); } }
        expect(")");
        return compound(t.value, args);
      }
      return atom(t.value);
    }
    // Bare string tokens used as atoms (e.g. operator chars in unusual positions)
    if (typeof t === "string" && !"()[],.:-\\+|".includes(t)) { advance(); return atom(t); }
    throw new Error(`Unexpected token: ${JSON.stringify(t)} at position ${pos}`);
  }

  const clauses = [];
  while (pos < tokens.length) {
    const head = parseTerm();
    let body = [];
    if (isToken(":-")) {
      advance();
      body.push(parseTerm());
      while (isToken(",")) { advance(); body.push(parseTerm()); }
    }
    expect(".");
    clauses.push({ head, body });
  }
  return clauses;
}

export function parsePrologText(text) { return parse(tokenize(text)); }

export function parseGoal(text) {
  const src = text.endsWith(".") ? text : text + ".";
  // Parse as a pseudo-clause with :- prefix so commas become body goals
  const wrapped = `_goal_ :- ${src}`;
  const parsed = parse(tokenize(wrapped));
  if (parsed.length === 0) throw new Error("Empty goal");
  return parsed[0].body;
}

// ═══════════════════════════════════════════════════════════
// Arithmetic evaluator
// ═══════════════════════════════════════════════════════════

function evalArith(term, subst) {
  term = deepWalk(term, subst);
  if (term.type === "number") return term.value;
  if (term.type === "compound" && term.args.length === 2) {
    const a = evalArith(term.args[0], subst);
    const b = evalArith(term.args[1], subst);
    if (a === null || b === null) return null;
    switch (term.functor) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b !== 0 ? Math.floor(a / b) : null;
      case "mod": return b !== 0 ? a % b : null;
      default: return null;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// Solver (SLD resolution with backtracking via generators)
// ═══════════════════════════════════════════════════════════

const CMP = { ">=": (a, b) => a >= b, ">": (a, b) => a > b, "<": (a, b) => a < b, "=<": (a, b) => a <= b, "=:=": (a, b) => a === b, "=\\=": (a, b) => a !== b };

// RT10-M2: Configurable depth limit with cycle detection.
// Previous hardcoded 1000 could be silently hit by circular rules, causing
// gates to pass without detecting violations. Cycle detection tracks
// goal signatures to catch infinite loops earlier than depth limit.
const MAX_SOLVE_DEPTH = 500;  // Lower limit — circular rules hit this faster
const _goalHistory = new Set();

function* solve(goals, subst, db, depth = 0) {
  if (depth > MAX_SOLVE_DEPTH) return; // recursion guard
  // Cycle detection: track goal+depth signature to detect infinite loops
  if (goals.length > 0 && depth > 50) {
    const sig = JSON.stringify(goals.map(g => deepWalk(g, subst)));
    if (_goalHistory.has(sig)) return; // cycle detected — prune
    _goalHistory.add(sig);
    if (_goalHistory.size > 10000) _goalHistory.clear(); // prevent memory bloat
  }
  if (goals.length === 0) { yield subst; return; }

  const [goal, ...rest] = goals;
  const g = deepWalk(goal, subst);

  // --- Built-in dispatch ---

  // true / fail
  if (g.type === "atom" && g.name === "true") { yield* solve(rest, subst, db, depth + 1); return; }
  if (g.type === "atom" && g.name === "fail") { return; }

  // Conjunction (,)/2
  if (g.type === "compound" && g.functor === "," && g.args.length === 2) {
    yield* solve([g.args[0], g.args[1], ...rest], subst, db, depth + 1); return;
  }
  // Disjunction (;)/2
  if (g.type === "compound" && g.functor === ";" && g.args.length === 2) {
    yield* solve([g.args[0], ...rest], subst, db, depth + 1);
    yield* solve([g.args[1], ...rest], subst, db, depth + 1);
    return;
  }

  // Negation \+/1
  if (g.type === "compound" && g.functor === "\\+" && g.args.length === 1) {
    let found = false;
    for (const _ of solve([g.args[0]], subst, db, depth + 1)) { found = true; break; }
    if (!found) yield* solve(rest, subst, db, depth + 1);
    return;
  }

  // Unification =/2
  if (g.type === "compound" && g.functor === "=" && g.args.length === 2) {
    const s = unify(g.args[0], g.args[1], subst);
    if (s) yield* solve(rest, s, db, depth + 1);
    return;
  }
  // Not unifiable \=/2
  if (g.type === "compound" && g.functor === "\\=" && g.args.length === 2) {
    if (!unify(deepWalk(g.args[0], subst), deepWalk(g.args[1], subst), new Map()))
      yield* solve(rest, subst, db, depth + 1);
    return;
  }

  // Arithmetic is/2
  if (g.type === "compound" && g.functor === "is" && g.args.length === 2) {
    const val = evalArith(g.args[1], subst);
    if (val !== null) { const s = unify(g.args[0], num(val), subst); if (s) yield* solve(rest, s, db, depth + 1); }
    return;
  }
  // Comparisons
  if (g.type === "compound" && CMP[g.functor] && g.args.length === 2) {
    const a = evalArith(g.args[0], subst), b = evalArith(g.args[1], subst);
    if (a !== null && b !== null && CMP[g.functor](a, b)) yield* solve(rest, subst, db, depth + 1);
    return;
  }

  // member/2
  if (g.type === "compound" && g.functor === "member" && g.args.length === 2) {
    let cur = deepWalk(g.args[1], subst);
    while (cur.type === "compound" && cur.functor === "." && cur.args.length === 2) {
      const s = unify(g.args[0], cur.args[0], subst);
      if (s) yield* solve(rest, s, db, depth + 1);
      cur = deepWalk(cur.args[1], subst);
    }
    return;
  }

  // append/3
  if (g.type === "compound" && g.functor === "append" && g.args.length === 3) {
    yield* solveAppend(g.args[0], g.args[1], g.args[2], rest, subst, db, depth);
    return;
  }

  // length/2
  if (g.type === "compound" && g.functor === "length" && g.args.length === 2) {
    const arr = listToArray(deepWalk(g.args[0], subst), subst);
    const s = unify(g.args[1], num(arr.length), subst);
    if (s) yield* solve(rest, s, db, depth + 1);
    return;
  }

  // findall/3
  if (g.type === "compound" && g.functor === "findall" && g.args.length === 3) {
    const results = [];
    for (const s of solve([g.args[1]], subst, db, depth + 1)) results.push(deepWalk(g.args[0], s));
    const s = unify(g.args[2], list(results), subst);
    if (s) yield* solve(rest, s, db, depth + 1);
    return;
  }

  // forall/2: succeed if for every solution of Cond, Action also succeeds
  if (g.type === "compound" && g.functor === "forall" && g.args.length === 2) {
    let ok = true;
    for (const s of solve([g.args[0]], subst, db, depth + 1)) {
      let actionOk = false;
      for (const _ of solve([g.args[1]], s, db, depth + 1)) { actionOk = true; break; }
      if (!actionOk) { ok = false; break; }
    }
    if (ok) yield* solve(rest, subst, db, depth + 1);
    return;
  }

  // write/1 writeln/1
  if (g.type === "compound" && (g.functor === "write" || g.functor === "writeln") && g.args.length === 1) {
    const s = termToString(deepWalk(g.args[0], subst));
    if (g.functor === "writeln") console.log(s); else process.stdout.write(s);
    yield* solve(rest, subst, db, depth + 1);
    return;
  }
  // nl/0
  if (g.type === "atom" && g.name === "nl") {
    console.log();
    yield* solve(rest, subst, db, depth + 1);
    return;
  }

  // Type checks
  if (g.type === "compound" && g.args.length === 1) {
    const a = deepWalk(g.args[0], subst);
    if (g.functor === "number" && a.type === "number") { yield* solve(rest, subst, db, depth + 1); return; }
    if (g.functor === "atom" && a.type === "atom") { yield* solve(rest, subst, db, depth + 1); return; }
    if (g.functor === "var" && a.type === "var") { yield* solve(rest, subst, db, depth + 1); return; }
    if (g.functor === "nonvar" && a.type !== "var") { yield* solve(rest, subst, db, depth + 1); return; }
    if (g.functor === "is_list") {
      let c = a;
      while (c.type === "compound" && c.functor === "." && c.args.length === 2) c = c.args[1];
      if (c.type === "atom" && c.name === "[]") { yield* solve(rest, subst, db, depth + 1); }
      return;
    }
    // Fall through to user-defined clauses for other compound/1 terms
  }

  // --- User-defined clauses ---
  const key = g.type === "atom" ? g.name + "/0"
            : g.type === "compound" ? g.functor + "/" + g.args.length
            : null;
  if (!key) return;

  const clauses = db.get(key) || [];
  for (const clause of clauses) {
    const renamed = renameClause(clause);
    const s = unify(g, renamed.head, new Map(subst));
    if (s) yield* solve([...renamed.body, ...rest], s, db, depth + 1);
  }
}

// append/3 implementation via backtracking
function* solveAppend(l1, l2, l3, rest, subst, db, depth) {
  // Base: append([], L, L)
  const s1 = unify(l1, NIL, subst);
  if (s1) { const s2 = unify(l2, l3, s1); if (s2) yield* solve(rest, s2, db, depth + 1); }
  // Recursive: append([H|T1], L2, [H|T3]) :- append(T1, L2, T3)
  const h = variable(`_ap${_vc}_H`), t1 = variable(`_ap${_vc}_T1`), t3 = variable(`_ap${_vc++}_T3`);
  const s3 = unify(l1, compound(".", [h, t1]), subst);
  if (s3) { const s4 = unify(l3, compound(".", [h, t3]), s3); if (s4) yield* solveAppend(t1, l2, t3, rest, s4, db, depth + 1); }
}

function listToArray(term, subst) {
  const arr = [];
  let c = deepWalk(term, subst);
  while (c.type === "compound" && c.functor === "." && c.args.length === 2) {
    arr.push(deepWalk(c.args[0], subst));
    c = deepWalk(c.args[1], subst);
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════
// Term pretty-printer
// ═══════════════════════════════════════════════════════════

export function termToString(t) {
  if (t.type === "atom") {
    // Quote atoms with special chars or that start with uppercase
    if (/^[a-z][a-zA-Z0-9_]*$/.test(t.name) || t.name === "[]") return t.name;
    return `'${t.name}'`;
  }
  if (t.type === "number") return String(t.value);
  if (t.type === "var") return t.name;
  if (t.type === "compound") {
    if (t.functor === "." && t.args.length === 2) {
      const elems = [];
      let cur = t;
      while (cur.type === "compound" && cur.functor === "." && cur.args.length === 2) {
        elems.push(termToString(cur.args[0]));
        cur = cur.args[1];
      }
      if (cur.type === "atom" && cur.name === "[]") return `[${elems.join(", ")}]`;
      return `[${elems.join(", ")} | ${termToString(cur)}]`;
    }
    return `${t.functor}(${t.args.map(termToString).join(", ")})`;
  }
  return String(t);
}

// Convert term to JS-native value
function termToReadable(term) {
  if (term.type === "atom") return term.name;
  if (term.type === "number") return term.value;
  if (term.type === "var") return `?${term.name}`;
  if (term.type === "compound") {
    if (term.functor === "." && term.args.length === 2) {
      const arr = [];
      let cur = term;
      while (cur.type === "compound" && cur.functor === "." && cur.args.length === 2) {
        arr.push(termToReadable(cur.args[0]));
        cur = cur.args[1];
      }
      if (cur.type === "atom" && cur.name === "[]") return arr;
      return [...arr, "|", termToReadable(cur)];
    }
    return { functor: term.functor, args: term.args.map(termToReadable) };
  }
  return term;
}

// ═══════════════════════════════════════════════════════════
// Session API
// ═══════════════════════════════════════════════════════════

export function createSession() {
  const db = new Map();

  function addClause(clause) {
    const key = clause.head.type === "atom" ? clause.head.name + "/0"
              : clause.head.type === "compound" ? clause.head.functor + "/" + clause.head.args.length
              : null;
    if (!key) throw new Error(`Invalid clause head: ${JSON.stringify(clause.head)}`);
    if (!db.has(key)) db.set(key, []);
    db.get(key).push(clause);
  }

  function consultText(text) {
    for (const c of parsePrologText(text)) addClause(c);
  }

  function consultFile(path) {
    try {
      consultText(readFileSync(path, "utf-8"));
    } catch (e) {
      throw new Error(`Failed to load Prolog rules from ${path}: ${e.message}`);
    }
  }

  return {
    consult(text) { consultText(text); },
    consultFile(path) { consultFile(path); },
    assert(text) { consultText(text); },

    *query(goalText) {
      const goals = parseGoal(goalText);
      const goalVars = new Set();
      function collectVars(t) {
        if (t.type === "var" && !t.name.startsWith("_")) goalVars.add(t.name);
        if (t.type === "compound") t.args.forEach(collectVars);
      }
      goals.forEach(collectVars);

      for (const subst of solve(goals, new Map(), db)) {
        const result = {};
        for (const v of goalVars) {
          if (subst.has(v)) result[v] = termToReadable(deepWalk(variable(v), subst));
        }
        yield result;
      }
    },

    queryAll(goalText) { return [...this.query(goalText)]; },

    queryOne(goalText) {
      for (const r of this.query(goalText)) return r;
      return null;
    },

    // Returns true if the goal has at least one solution
    check(goalText) { return this.queryOne(goalText) !== null; },

    get db() { return db; },
  };
}

// ═══════════════════════════════════════════════════════════
// Self-test (run: node prolog.mjs --self-test)
// ═══════════════════════════════════════════════════════════

function selfTest() {
  console.log("Running Prolog interpreter self-tests...\n");
  let pass = 0, fail = 0;
  function assert(name, cond) {
    if (cond) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}`); fail++; }
  }

  // 1. Simple facts and queries
  const s1 = createSession();
  s1.consult("parent(tom, bob). parent(bob, ann). parent(bob, pat).");
  assert("Simple query match", s1.check("parent(tom, bob)"));
  assert("Simple query fail", !s1.check("parent(ann, tom)"));
  assert("Variable binding", s1.queryOne("parent(tom, X)")?.X === "bob");
  assert("Multiple results", s1.queryAll("parent(bob, X)").length === 2);

  // 2. Rules and recursion
  const s2 = createSession();
  s2.consult("parent(tom, bob). parent(bob, ann).");
  s2.consult("ancestor(X, Y) :- parent(X, Y).");
  s2.consult("ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).");
  assert("Direct ancestor", s2.check("ancestor(tom, bob)"));
  assert("Transitive ancestor", s2.check("ancestor(tom, ann)"));
  assert("Not ancestor", !s2.check("ancestor(ann, tom)"));

  // 3. Lists and member
  const s3 = createSession();
  s3.consult("colors([red, green, blue]).");
  assert("Member of list", s3.check("colors(L), member(red, L)"));
  assert("Not member of list", !s3.check("colors(L), member(yellow, L)"));

  // 4. Negation
  const s4 = createSession();
  s4.consult("likes(tom, beer). likes(tom, wine).");
  assert("Negation success (\\+ for absent)", s4.check("\\+ likes(tom, water)"));
  assert("Negation failure (\\+ for present)", !s4.check("\\+ likes(tom, beer)"));

  // 5. Arithmetic
  const s5 = createSession();
  assert("Arithmetic is/2", s5.queryOne("X is 2 + 3")?.X === 5);
  assert("Comparison >=", s5.check("5 >= 3"));
  assert("Comparison < failure", !s5.check("5 < 3"));

  // 6. findall
  const s6 = createSession();
  s6.consult("color(red). color(green). color(blue).");
  const r6 = s6.queryOne("findall(X, color(X), L)");
  assert("findall collects all", Array.isArray(r6?.L) && r6.L.length === 3);

  // 7. forall
  const s7 = createSession();
  s7.consult("positive(1). positive(2). positive(3).");
  assert("forall pass (all > 0)", s7.check("forall(positive(X), X > 0)"));
  assert("forall fail (not all > 1)", !s7.check("forall(positive(X), X > 1)"));

  // 8. Not unifiable
  assert("\\= different atoms", s5.check("a \\= b"));
  assert("\\= same atoms fails", !s5.check("a \\= a"));

  // 9. append
  const s9 = createSession();
  const r9 = s9.queryOne("append([1, 2], [3, 4], L)");
  assert("append/3", Array.isArray(r9?.L) && r9.L.length === 4);

  // 10. length
  assert("length/2", s9.queryOne("length([a, b, c], N)")?.N === 3);

  // 11. Dependency chain (transitive closure)
  const s11 = createSession();
  s11.consult(`
    requires(export, login).
    requires(export, data_loaded).
    requires(data_loaded, login).
    depends_on(X, Y) :- requires(X, Y).
    depends_on(X, Y) :- requires(X, Z), depends_on(Z, Y).
  `);
  assert("Direct dependency", s11.check("depends_on(export, login)"));
  assert("Transitive dependency", s11.check("depends_on(export, login)"));
  const deps = s11.queryAll("depends_on(export, X)");
  assert("All dependencies found", deps.length >= 2);

  // 12. Conflict detection pattern
  const s12 = createSession();
  s12.consult(`
    postcondition(us_002, denies_access(deactivated, profile)).
    postcondition(us_015, grants_access(deactivated, profile)).
    conflict(S1, S2, Reason) :-
      postcondition(S1, grants_access(U, R)),
      postcondition(S2, denies_access(U, R)),
      S1 \\= S2,
      Reason = conflicting_access(U, R).
  `);
  const conflict = s12.queryOne("conflict(S1, S2, Reason)");
  assert("Conflict detection", conflict !== null && conflict.S1 === "us_015");

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// CLI entry
const isMain = process.argv[1] && (
  process.argv[1].endsWith("prolog.mjs") ||
  process.argv[1].endsWith("prolog.mjs/")
);
if (isMain && process.argv.includes("--self-test")) selfTest();
