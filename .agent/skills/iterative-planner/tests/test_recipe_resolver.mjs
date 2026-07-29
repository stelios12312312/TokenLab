#!/usr/bin/env node
// test_recipe_resolver.mjs - E6-7 ranked recipe resolver proof.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  evaluateRankedRecipeResolverAgainstLegacy,
  resolveRecipeRequest,
} from "../scripts/lib/recipe_utils.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}${details ? ` - ${details}` : ""}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), "recipe-resolver-e6-7-"));
}

function installRecipeProject(root) {
  const recipesDir = join(root, "recipes");
  mkdirSync(recipesDir, { recursive: true });

  writeJson(join(recipesDir, "entity_registry.json"), {
    entities: [
      {
        id: "eventbrite_bootcamp",
        title: "AI Fluency Bootcamp Eventbrite roster",
        aliases: ["AI Fluency Bootcamp", "Eventbrite registrants", "bootcamp attendees"],
        systems: { eventbrite: "Eventbrite ticketing export" },
        recipe_ids: ["get-participants"],
      },
      {
        id: "ipbs_research_pack",
        title: "IPBS datapack starter research universe",
        aliases: ["IPBS datapack", "sports modelling research pack", "walk forward dataset"],
        systems: { python: "offline research runner" },
        recipe_ids: ["walk-forward-opt", "meta-portfolio"],
      },
      {
        id: "crawler_source_site",
        title: "Crawler extractor source site",
        aliases: ["website extraction target", "crawl source", "page corpus"],
        systems: { browser: "headless crawler" },
        recipe_ids: ["crawl-extract-pages"],
      },
      {
        id: "evolution_trading_scientist",
        title: "Evolution trading scientist research loop",
        aliases: ["trading scientist", "strategy lab", "evolution research"],
        systems: { node: "strategy report generator" },
        recipe_ids: ["strategy-report"],
      },
    ],
  });

  writeJson(join(recipesDir, "capability_registry.json"), {
    capabilities: [
      {
        id: "eventbrite_people_export",
        title: "Eventbrite attendee participant roster export",
        description: "Prepare a people, attendee, participant, or registrant export for an Eventbrite bootcamp.",
        triggers: [{ pattern: "^get participants for (?<value>.+)$", weight: 10 }],
        parameters: [{ name: "event", required: false, patterns: ["(?:for|from) (?<value>.+)$"] }],
        recipe_ids: ["get-participants"],
        supported_entities: ["eventbrite_bootcamp"],
        skills: ["eventbrite", "csv"],
      },
      {
        id: "ipbs_walk_forward_optimizer",
        title: "IPBS walk-forward optimisation and CPCV validation",
        description: "Run walk forward validation, split design, and leakage-aware optimisation for an IPBS datapack.",
        triggers: [{ pattern: "^run walk forward optimisation$", weight: 10 }],
        recipe_ids: ["walk-forward-opt"],
        supported_entities: ["ipbs_research_pack"],
        skills: ["quant", "validation"],
      },
      {
        id: "ipbs_meta_portfolio",
        title: "IPBS meta portfolio ensemble allocation",
        description: "Build a portfolio blend, ensemble, or allocation report from IPBS candidate model outputs.",
        triggers: [{ pattern: "^build meta portfolio$", weight: 10 }],
        recipe_ids: ["meta-portfolio"],
        supported_entities: ["ipbs_research_pack"],
        skills: ["portfolio", "ensemble"],
      },
      {
        id: "crawler_page_extractor",
        title: "Crawler extractor page collection",
        description: "Crawl, scrape, extract, and collect page content from a target site into structured artifacts.",
        triggers: [{ pattern: "^crawl site (?<value>.+)$", weight: 10 }],
        recipe_ids: ["crawl-extract-pages"],
        supported_entities: ["crawler_source_site"],
        skills: ["crawler", "extractor"],
      },
      {
        id: "evolution_strategy_report",
        title: "Evolution trading scientist strategy report",
        description: "Generate trading scientist research summaries, strategy lab reports, and experiment receipts.",
        triggers: [{ pattern: "^generate strategy report$", weight: 10 }],
        recipe_ids: ["strategy-report"],
        supported_entities: ["evolution_trading_scientist"],
        skills: ["trading", "research"],
      },
    ],
  });

  const recipeDefinitions = [
    ["get-participants", "Eventbrite participants export", "eventbrite_people_export", ["eventbrite_bootcamp"], ["eventbrite", "csv"]],
    ["walk-forward-opt", "IPBS walk-forward optimizer", "ipbs_walk_forward_optimizer", ["ipbs_research_pack"], ["quant", "validation"]],
    ["meta-portfolio", "IPBS meta portfolio builder", "ipbs_meta_portfolio", ["ipbs_research_pack"], ["portfolio", "ensemble"]],
    ["crawl-extract-pages", "Crawler extractor page collector", "crawler_page_extractor", ["crawler_source_site"], ["crawler", "extractor"]],
    ["strategy-report", "Evolution trading scientist report", "evolution_strategy_report", ["evolution_trading_scientist"], ["trading", "research"]],
  ];

  for (const [id, title, capabilityId, entityIds, skills] of recipeDefinitions) {
    const recipeDir = join(recipesDir, id);
    mkdirSync(recipeDir, { recursive: true });
    writeJson(join(recipeDir, "recipe.json"), {
      id,
      title,
      capability_id: capabilityId,
      entity_ids: entityIds,
      required_params: [],
      skills,
      runner: {
        type: "command",
        cwd: ".",
        command: ["node", "-e", `console.log(${JSON.stringify(id)})`],
        defaults: {},
        dry_run_flags: ["--dry-run"],
        live_flags: [],
      },
    });
  }
}

const CASES = [
  {
    id: "eventbrite_people_export",
    project_family: "eventbrite-bootcamp",
    goal: "Prepare the Eventbrite people export for the AI Fluency Bootcamp",
    expected_recipe_id: "get-participants",
  },
  {
    id: "eventbrite_roster",
    project_family: "eventbrite-bootcamp",
    goal: "Pull the bootcamp attendee roster into a CSV",
    expected_recipe_id: "get-participants",
  },
  {
    id: "eventbrite_registrants",
    project_family: "eventbrite-bootcamp",
    goal: "Collect registrants from Eventbrite for the fluency course",
    expected_recipe_id: "get-participants",
  },
  {
    id: "ipbs_walk_forward",
    project_family: "ipbs-datapack-starter",
    goal: "Run leakage-aware walk forward validation on the IPBS datapack",
    expected_recipe_id: "walk-forward-opt",
  },
  {
    id: "ipbs_cpcv",
    project_family: "ipbs-datapack-starter",
    goal: "Prepare CPCV split optimisation for the sports modelling research pack",
    expected_recipe_id: "walk-forward-opt",
  },
  {
    id: "ipbs_portfolio",
    project_family: "ipbs-datapack-starter",
    goal: "Build an ensemble allocation report from IPBS candidate models",
    expected_recipe_id: "meta-portfolio",
  },
  {
    id: "crawler_extract",
    project_family: "crawler-extractor-agent",
    goal: "Extract structured page content from the target website",
    expected_recipe_id: "crawl-extract-pages",
  },
  {
    id: "crawler_collect",
    project_family: "crawler-extractor-agent",
    goal: "Collect the site page corpus with the crawler extractor",
    expected_recipe_id: "crawl-extract-pages",
  },
  {
    id: "evolution_report",
    project_family: "evolution-trading-scientist",
    goal: "Generate the evolution trading scientist experiment report",
    expected_recipe_id: "strategy-report",
  },
  {
    id: "evolution_strategy_lab",
    project_family: "evolution-trading-scientist",
    goal: "Summarize the strategy lab research receipts for trading scientist",
    expected_recipe_id: "strategy-report",
  },
];

console.log("\nRecipe Resolver E6-7 Tests\n");

const tmp = makeTempProject();
try {
  installRecipeProject(tmp);

  const evaluation = evaluateRankedRecipeResolverAgainstLegacy({ cwd: tmp, cases: CASES });
  assert(evaluation.case_count === 10, "side-by-side resolver eval covers 10 goal phrases");
  assert(evaluation.project_family_count === 4, "side-by-side resolver eval covers four adopting project families");
  assert(evaluation.ranked_top_1_hits === 10, "ranked resolver hits expected top-1 recipe for every phrase", JSON.stringify(evaluation.rows, null, 2));
  assert(evaluation.legacy_top_1_hits < evaluation.ranked_top_1_hits, "ranked resolver beats legacy exact alias/regex matching");
  assert(evaluation.ranked_beats_legacy === true && evaluation.improvement > 0, "evaluation records positive ranked resolver delta");

  const known = resolveRecipeRequest({
    cwd: tmp,
    goalText: "Prepare the Eventbrite people export for the AI Fluency Bootcamp",
  });
  assert(known.resolver?.strategy === "ranked_bm25_graph_v1", "resolver reports ranked strategy metadata");
  assert(known.primary_resolution?.route === "execute_known_recipe", "known fleet recipe resolves to execute_known_recipe");
  assert(known.primary_resolution?.recipe_id === "get-participants", "known fleet recipe resolves to get-participants");
  assert(known.entities?.[0]?.id === "eventbrite_bootcamp", "ranked resolver selects the matching entity");
  assert(known.capabilities?.[0]?.id === "eventbrite_people_export", "ranked resolver selects the matching capability");

  const noMatch = resolveRecipeRequest({
    cwd: tmp,
    goalText: "Write a haiku about planning calmly",
  });
  assert(noMatch.primary_resolution?.route === "plan_build", "registry-present no-match falls through to normal plan build");

  const noRegistry = makeTempProject();
  try {
    const operational = resolveRecipeRequest({ cwd: noRegistry, goalText: "Export contacts from the CRM pipeline" });
    assert(operational.primary_resolution?.route === "recipe_discovery", "operational request with no registry routes to recipe discovery");
    const unconfigured = resolveRecipeRequest({ cwd: noRegistry, goalText: "Explain the project status" });
    assert(unconfigured.primary_resolution?.route === "unconfigured", "non-operational request with no registry reports unconfigured");
  } finally {
    rmSync(noRegistry, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) process.exit(1);
