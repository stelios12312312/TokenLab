import test from "node:test";
import assert from "node:assert/strict";
import { createSession, QueryDepthError, QueryTimeoutError } from "../scripts/lib/prolog.mjs";

test("Prolog solver preserves sibling alternatives across depths", async (t) => {
  const depthsToTest = [0, 10, 49, 50, 51, 60, 100];

  for (const depth of depthsToTest) {
    await t.test(`preserves alternatives at depth ${depth}`, () => {
      const session = createSession();
      let rules = `
choice(alpha).
choice(beta).
choice(gamma).
tail_check.
`;
      for (let i = 0; i < depth; i++) {
        rules += `step_${i}(X) :- step_${i + 1}(X).\n`;
      }
      rules += `step_${depth}(X) :- choice(X), tail_check.\n`;
      session.consult(rules);

      const results = session.queryAll("step_0(X).");
      assert.equal(results.length, 3, `Expected 3 answers at depth ${depth}, got ${results.length}`);
      assert.deepEqual(
        results.map((r) => r.X),
        ["alpha", "beta", "gamma"]
      );
    });
  }

  await t.test("nested disjunctions via multiple clauses at depth 60", () => {
    const session = createSession();
    let rules = `
item(1).
item(2).
alt(X) :- item(X).
post(ok).
`;
    for (let i = 0; i < 60; i++) {
      rules += `nest_${i}(X) :- nest_${i + 1}(X).\n`;
    }
    rules += `nest_60(X) :- alt(X), post(ok).\n`;
    session.consult(rules);

    const results = session.queryAll("nest_0(A).");
    assert.equal(results.length, 2, `Expected 2 answers for multiple clauses, got ${results.length}`);
    assert.deepEqual(results.map((r) => r.A), [1, 2]);
  });

  await t.test("infinite single-step loop terminates safely via cycle detection", () => {
    const session = createSession();
    session.consult(`
loop :- loop.
finite(1).
test_goal(X) :- loop, finite(X).
`);
    const results = session.queryAll("test_goal(X).");
    assert.deepEqual(results, []);
  });

  await t.test("infinite multi-step cyclic rule terminates safely via cycle detection", () => {
    const session = createSession();
    session.consult(`
ping :- pong.
pong :- ping.
query_ping :- ping.
`);
    const results = session.queryAll("query_ping.");
    assert.deepEqual(results, []);
  });

  await t.test("deep non-cyclic chain exceeding MAX_SOLVE_DEPTH throws QueryDepthError", () => {
    const session = createSession();
    let rules = "";
    for (let i = 0; i < 550; i++) {
      rules += `deep_${i} :- deep_${i + 1}.\n`;
    }
    rules += `deep_550.\n`;
    session.consult(rules);

    assert.throws(
      () => {
        session.queryAll("deep_0.");
      },
      QueryDepthError,
      "Expected QueryDepthError when search depth exceeds 500"
    );
  });

  await t.test("flat conjunction of 60 true goals preserving multiple choice alternatives", () => {
    const session = createSession();
    const prefix = Array(60).fill("true").join(", ");
    session.consult(`
choice(first).
choice(second).
choice(third).
tail.
test_flat(X) :- ${prefix}, choice(X), tail.
`);
    const results = session.queryAll("test_flat(X).");
    assert.equal(results.length, 3, "Expected 3 answers after 60 flat conjunction goals");
    assert.deepEqual(results.map((r) => r.X), ["first", "second", "third"]);
  });

  await t.test("multiple choice conjunction at depth 55 preserves all combinations", () => {
    const session = createSession();
    let rules = `
color(red).
color(blue).
size(small).
size(large).
`;
    for (let i = 0; i < 55; i++) {
      rules += `chain_${i}(C, S) :- chain_${i + 1}(C, S).\n`;
    }
    rules += `chain_55(C, S) :- color(C), size(S).\n`;
    session.consult(rules);

    const results = session.queryAll("chain_0(C, S).");
    assert.equal(results.length, 4, "Expected 4 cartesian combinations at depth 55");
    assert.deepEqual(results, [
      { C: "red", S: "small" },
      { C: "red", S: "large" },
      { C: "blue", S: "small" },
      { C: "blue", S: "large" },
    ]);
  });

  await t.test("findall collects all solutions across depth 50+ alternatives", () => {
    const session = createSession();
    let rules = `
val(10).
val(20).
val(30).
`;
    for (let i = 0; i < 50; i++) {
      rules += `collect_${i}(X) :- collect_${i + 1}(X).\n`;
    }
    rules += `collect_50(X) :- val(X).\n`;
    rules += `test_collect(List) :- findall(V, collect_0(V), List).\n`;
    session.consult(rules);

    const results = session.queryAll("test_collect(L).");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].L, [10, 20, 30]);
  });
});
