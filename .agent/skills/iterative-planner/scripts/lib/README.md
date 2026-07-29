# Prolog Interpreter — Architecture & Extension Guide

> Internal documentation for `prolog.mjs` (this directory).

## Overview

A lightweight Prolog interpreter implemented in ~700 lines of JavaScript. Designed for the iterative planner's rule engine — not a general-purpose Prolog system.

## Term Representation

All Prolog terms are represented as JavaScript objects:

| Type | Structure | Example |
|------|-----------|---------|
| Atom | `{ type: "atom", name: "foo" }` | `foo` |
| Variable | `{ type: "var", name: "X" }` | `X` |
| Number | `{ type: "num", value: 42 }` | `42` |
| Compound | `{ type: "compound", functor: "f", args: [...] }` | `f(X, 1)` |
| List | Compound with functor `"."` and 2 args (head, tail) | `[a, b, c]` |

## Core Algorithm

Uses **SLD resolution** with depth-first search:

1. **`unify(t1, t2, substitution)`** — Robinson's unification algorithm (without occurs check)
2. **`solve(goals, substitution, depth)`** — SLD resolver using JavaScript generators for backtracking
3. **`query(goalString)`** — High-level entry: parse → solve → collect results

### Backtracking

Implemented via JavaScript generators (`function*`). Each `solve()` call `yield`s solutions, and the caller can request more by advancing the generator.

### Variable Renaming

Each clause is renamed before use (fresh variables via `_vc` counter) to prevent variable capture.

## Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| No occurs check | `X = f(X)` creates infinite structure | Recursion guard at depth 1000 |
| Integer arithmetic only | No floating-point `3.14` | All rule engine facts are integer/atom-based |
| No cut (`!`) | Cannot prune search space | Rules designed to avoid needing cut |
| No DCG / phrase support | No grammar rules | Not needed for planner use case |
| No module system | All predicates share global namespace | Rule files are small (~50 clauses each) |

## Built-ins

| Predicate | Description |
|-----------|-------------|
| `true` | Always succeeds |
| `fail` | Always fails |
| `\+/1` | Negation-as-failure |
| `=/2`, `\=/2` | Unification and its negation |
| `is/2` | Arithmetic evaluation (`X is 2 + 3`) |
| `=:=/2`, `=\=/2`, `</2`, `>/2`, `=</2`, `>=/2` | Arithmetic comparison |
| `atom/1`, `number/1`, `var/1`, `compound/1` | Type checking |
| `functor/3`, `arg/3`, `=../2` | Term manipulation (univ) |
| `member/2` | List membership |
| `append/3` | List concatenation |
| `length/2` | List length |
| `findall/3` | Collect all solutions |
| `forall/2` | Universal quantification |
| `write/1`, `writeln/1`, `nl/0` | Output |

## Adding a New Built-in

1. In `prolog.mjs`, find the `BUILTINS` map (around line 200)
2. Add your built-in as a generator function:

```js
BUILTINS.set("my_builtin/2", function*(args, subst, session, depth) {
  const [arg1, arg2] = args.map(a => deepWalk(a, subst));
  // ... your logic ...
  // yield a substitution to succeed, or return without yielding to fail
  yield subst;
});
```

3. Run `node rule_engine.mjs --self-test` to verify no regressions

## Self-Tests

25 self-tests cover: unification, backtracking, negation-as-failure, lists, arithmetic, findall, forall, cut-free resolution, and the recursion depth guard.

Run: `node scripts/lib/prolog.mjs` (self-test mode when run directly).
