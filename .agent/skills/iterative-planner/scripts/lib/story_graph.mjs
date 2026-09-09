// story_graph.mjs — native JS graph checks over story_registry.json dependencies.
//
// Replaces Prolog SLD backtracking (depends_on/2 transitive closure +
// circular_dependency/2) with O(V+E) Tarjan SCC analysis. The Prolog rules in
// stories.pl remain for small ad-hoc queries, but bulk invariant evaluation
// uses these helpers.

import { readFileSync } from "fs";
import { join } from "path";

export function loadStoryRegistryGraph(cwd = process.cwd()) {
  const path = join(cwd, "reports", "user_story_audit", "story_registry.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, ok: false, stories: [], edges: new Map() };
  }
  const stories = Array.isArray(parsed?.stories) ? parsed.stories : [];
  const ids = new Set(stories.map((story) => story?.id).filter(Boolean));
  const edges = new Map();
  for (const story of stories) {
    const from = story?.id;
    if (!from) continue;
    const deps = (Array.isArray(story.requires) ? story.requires : [])
      .filter((dep) => typeof dep === "string" && ids.has(dep));
    edges.set(from, deps);
  }
  return { path, ok: true, stories, edges };
}

/**
 * Tarjan's SCC algorithm, iterative to avoid call-stack limits.
 * Returns { components: string[][], selfLoops: string[] }.
 */
export function stronglyConnectedComponents(edges) {
  const indexOf = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  const selfLoopSet = new Set();
  for (const [node, deps] of edges) {
    for (const dep of deps) {
      if (dep === node) selfLoopSet.add(node);
    }
  }
  const selfLoops = [...selfLoopSet];
  let counter = 0;

  const roots = [...edges.keys()];
  for (const root of roots) {
    if (indexOf.has(root)) continue;
    const work = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, childIndex] = frame;
      if (childIndex === 0) {
        indexOf.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const deps = edges.get(node) || [];
      if (frame[1] < deps.length) {
        frame[1] += 1;
        const child = deps[frame[1] - 1];
        if (!indexOf.has(child)) {
          work.push([child, 0]);
        } else if (onStack.has(child)) {
          lowlink.set(node, Math.min(lowlink.get(node), indexOf.get(child)));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
        }
        if (lowlink.get(node) === indexOf.get(node)) {
          const component = [];
          let member;
          do {
            member = stack.pop();
            onStack.delete(member);
            component.push(member);
          } while (member !== node);
          if (component.length > 1) components.push(component);
        }
      }
    }
  }
  return { components, selfLoops };
}

/**
 * Circular story dependency pairs, matching Prolog circular_dependency/2
 * semantics: every ordered pair (a, b) where b reaches a and a reaches b.
 * Returns array of [a, b] pairs.
 */
export function findCircularStoryPairs(edges) {
  const { components, selfLoops } = stronglyConnectedComponents(edges);
  const pairs = [];
  for (const component of components) {
    for (const a of component) {
      for (const b of component) {
        if (a !== b) pairs.push([a, b]);
      }
    }
  }
  for (const node of selfLoops) pairs.push([node, node]);
  return pairs;
}
