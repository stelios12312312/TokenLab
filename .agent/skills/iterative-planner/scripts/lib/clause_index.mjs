// @planner:module = clause_index
// @planner:capability = deterministic_first_argument_clause_candidate_selection

/**
 * JavaScript first-argument index for one Prolog predicate.
 *
 * This narrows the candidate clause set for ground first arguments while
 * preserving insertion order and including variable-head clauses. It is an
 * optimization inside the embedded interpreter, not a separate Prolog runtime.
 */
export class ClauseIndex {
  constructor(key) {
    this.key = key;
    this.allClauses = [];
    this.varClauses = [];
    this.argIndex = new Map();
  }

  add(clause) {
    this.allClauses.push(clause);
    if (!clause.head || clause.head.type === "atom" || !clause.head.args || clause.head.args.length === 0) {
      this.varClauses.push(clause);
      return;
    }
    const firstArg = clause.head.args[0];
    if (firstArg.type === "var") {
      this.varClauses.push(clause);
      return;
    }
    const subKey = ClauseIndex.getTermKey(firstArg);
    if (!this.argIndex.has(subKey)) this.argIndex.set(subKey, []);
    this.argIndex.get(subKey).push(clause);
  }

  getMatching(firstArgTerm) {
    if (!firstArgTerm || firstArgTerm.type === "var") return this.allClauses;
    const subKey = ClauseIndex.getTermKey(firstArgTerm);
    const specific = this.argIndex.get(subKey) || [];
    if (specific.length === 0) return this.varClauses;
    if (this.varClauses.length === 0) return specific;

    return this.allClauses.filter((clause) => {
      const firstArg = clause.head?.args?.[0];
      return firstArg?.type === "var" || ClauseIndex.getTermKey(firstArg) === subKey;
    });
  }

  static getTermKey(term) {
    if (!term) return "*";
    if (term.type === "atom") return `a:${term.name}`;
    if (term.type === "number") return `n:${term.value}`;
    if (term.type === "compound") return `c:${term.functor}/${term.args?.length || 0}`;
    return "*";
  }

  clone() {
    const copy = new ClauseIndex(this.key);
    copy.allClauses = this.allClauses.slice();
    copy.varClauses = this.varClauses.slice();
    copy.argIndex = new Map();
    for (const [subKey, clauses] of this.argIndex.entries()) {
      copy.argIndex.set(subKey, clauses.slice());
    }
    return copy;
  }

  [Symbol.iterator]() {
    return this.allClauses[Symbol.iterator]();
  }

  get length() {
    return this.allClauses.length;
  }
}

export function createIndexedDb(initialMap = null) {
  const map = initialMap instanceof Map ? new Map(initialMap) : new Map();
  return {
    get(key) { return map.get(key); },
    has(key) { return map.has(key); },
    set(key, index) { map.set(key, index); },
    addClause(clause) {
      const key = clause.head.type === "atom"
        ? `${clause.head.name}/0`
        : clause.head.type === "compound"
          ? `${clause.head.functor}/${clause.head.args.length}`
          : null;
      if (!key) throw new Error(`Invalid clause head: ${JSON.stringify(clause.head)}`);
      if (!map.has(key)) map.set(key, new ClauseIndex(key));
      map.get(key).add(clause);
    },
    clone() {
      const clonedMap = new Map();
      for (const [key, index] of map.entries()) {
        clonedMap.set(key, index.clone());
      }
      return createIndexedDb(clonedMap);
    },
    copyFrom(sourceDb) {
      const sourceMap = sourceDb?.rawMap || sourceDb;
      if (sourceMap && typeof sourceMap.entries === "function") {
        for (const [key, index] of sourceMap.entries()) {
          map.set(key, typeof index.clone === "function" ? index.clone() : index);
        }
      }
    },
    clear() { map.clear(); },
    keys() { return map.keys(); },
    entries() { return map.entries(); },
    get rawMap() { return map; },
  };
}
