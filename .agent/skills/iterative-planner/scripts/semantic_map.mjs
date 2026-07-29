#!/usr/bin/env node
// semantic_map.mjs — Generate and validate stewardship semantic maps.
//
// Usage:
//   node semantic_map.mjs generate --focus "AI Fluency"
//   node semantic_map.mjs generate --focus "AI Fluency" --json
//   node semantic_map.mjs check reports/stewardship/semantic_map.json
//   node semantic_map.mjs summary reports/stewardship/semantic_map.json
//
// Zero dependencies — Node.js 18+.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { buildStoryEvidenceReport } from "./story_registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const skillDir = resolve(scriptDir, "..");

const DEFAULT_OUT = join(process.cwd(), "reports", "stewardship", "semantic_map.json");
const SCHEMA_PATH = join(skillDir, "config", "semantic_map.schema.json");

const ENTITY_TYPES = new Set([
  "page",
  "funnel",
  "campaign",
  "asset",
  "persona",
  "story",
  "workflow",
  "telemetry_artifact",
  "finding",
  "test",
  "doc",
  "rule",
]);

const ENTITY_SURFACES = new Set([
  "website",
  "funnel",
  "campaign",
  "crm",
  "telemetry",
  "planner",
  "workflow",
  "docs",
  "tests",
  "ontology",
]);

const ENTITY_STATUSES = new Set(["active", "draft", "stale", "missing", "unknown"]);
const RELATION_TYPES = new Set([
  "contains",
  "drives_traffic_to",
  "measures",
  "audits",
  "implements",
  "validates",
  "documents",
  "links_to_story",
  "depends_on",
  "finds_issue_in",
  "owns",
]);
const RELATION_CONFIDENCE = new Set(["high", "medium", "low"]);
const OBLIGATION_TYPES = new Set([
  "story_link",
  "test_link",
  "doc_sync",
  "taxonomy_sync",
  "telemetry_grounding",
  "cta_wiring",
  "persona_coverage",
  "workflow_dispatch",
  "ontology_rule",
  "human_review",
]);
const OBLIGATION_STATUS = new Set(["open", "in_progress", "satisfied", "waived"]);
const DRIFT_CATEGORIES = new Set([
  "coverage_drift",
  "taxonomy_drift",
  "telemetry_gap",
  "story_gap",
  "workflow_gap",
  "doc_drift",
  "persona_gap",
]);
const DRIFT_SEVERITY = new Set(["critical", "high", "medium", "low"]);
const FOCUS_VALUES = new Set([
  "website",
  "funnel",
  "campaign",
  "crm",
  "telemetry",
  "planner",
  "workflow",
  "docs",
  "traceability",
]);
const WEAK_TOKENS = new Set([
  "ai",
  "the",
  "and",
  "for",
  "with",
  "from",
  "page",
  "pages",
  "website",
  "landing",
  "site",
  "funnel",
  "campaign",
  "campaigns",
  "marketing",
  "offer",
  "offers",
  "academy",
]);
const STOP_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "your",
  "their",
  "our",
  "has",
  "have",
  "will",
  "must",
  "should",
  "can",
  "via",
  "are",
  "was",
  "were",
  "being",
  "been",
  "not",
]);
const CHANNEL_HINT_TOKENS = ["facebook", "fb", "meta", "ads", "campaign"];

function usage() {
  console.log(`Usage: node semantic_map.mjs <command> [options]

Commands:
  generate             Generate reports/stewardship/semantic_map.json
  check [file]         Validate an existing semantic map
  summary [file]       Print counts and open-obligation summary

Options:
  --focus "<topic>"    Focus string used to select funnel/story/asset surfaces
  --out <file>         Output path for generate (default: reports/stewardship/semantic_map.json)
  --json               Emit JSON instead of human-readable output
`);
}

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function walkDir(dir, filter = () => true) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(full, filter));
    } else if (filter(entry.name, full)) {
      results.push(full);
    }
  }
  return results;
}

function relPath(path) {
  return relative(process.cwd(), path).replace(/\\/g, "/");
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function toId(...parts) {
  return parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildFocusProfile(focus) {
  const raw = String(focus || "").trim().toLowerCase();
  const tokens = uniqueStrings(
    tokenize(raw).filter((token) => token.length >= 2 && !STOP_TOKENS.has(token))
  );
  const strongTokens = tokens.filter((token) => token.length >= 4 && !WEAK_TOKENS.has(token));
  return {
    raw,
    tokens,
    strongTokens: strongTokens.length > 0 ? strongTokens : tokens.filter((token) => !WEAK_TOKENS.has(token)),
  };
}

function textMatchScore(text, focusProfile, extraTokens = []) {
  const haystack = String(text || "").toLowerCase();
  const focus = focusProfile || buildFocusProfile("");
  const scoreTokens = uniqueStrings([...(focus.strongTokens || []), ...extraTokens]);
  if (!focus.raw && scoreTokens.length === 0) return 1;

  let score = 0;
  if (focus.raw && haystack.includes(focus.raw)) score += 4;
  for (const token of scoreTokens) {
    if (token && haystack.includes(token)) score += 1;
  }
  return score;
}

function markdownTitle(text, fallback = "Untitled") {
  const match = String(text || "").match(/^#\s+(.+)$/m);
  return (match?.[1] || fallback).trim();
}

function extractUrls(text) {
  return uniqueStrings(String(text || "").match(/https?:\/\/[^\s)>"']+/g) || []);
}

function extractHtmlTitle(text, fallback) {
  const title = String(text || "").match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  if (title) return title;
  const h1 = String(text || "").match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1]?.replace(/<[^>]+>/g, " ").trim();
  return h1 || fallback;
}

function detectPlaceholderCta(text) {
  return /href\s*=\s*["']#["']/i.test(String(text || ""));
}

function extractTargetUrlFromCmoOutput(output) {
  if (!output || typeof output !== "object") return null;
  if (typeof output.url === "string" && output.url.trim()) return output.url.trim();
  if (typeof output.target_url === "string" && output.target_url.trim()) return output.target_url.trim();
  const prompt = String(output.advisory_prompt || "");
  const match = prompt.match(/##\s*Target URL:\s*(https?:\/\/\S+)/i);
  return match?.[1] || null;
}

function extractTelemetryBlock(output) {
  const prompt = String(output?.advisory_prompt || "");
  const match = prompt.match(/##\s*Telemetry Context\s*```json\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractCategoriesFromText(text) {
  const upper = String(text || "").toUpperCase();
  const matches = upper.match(/\b[A-Z][A-Z_]{2,}\b/g) || [];
  return uniqueStrings(matches.filter((value) => value.includes("_")));
}

function inferStatusFromText(text, defaultStatus = "active") {
  const haystack = String(text || "").toLowerCase();
  if (haystack.includes("upcoming") || haystack.includes("next steps") || haystack.includes("finalize")) return "draft";
  if (haystack.includes("stale") || haystack.includes("legacy")) return "stale";
  return defaultStatus;
}

function addEntity(entityMap, entity) {
  const current = entityMap.get(entity.id);
  const next = { ...entity };
  next.source_refs = uniqueStrings(next.source_refs);
  next.story_refs = uniqueStrings(next.story_refs);
  next.test_refs = uniqueStrings(next.test_refs);
  next.doc_refs = uniqueStrings(next.doc_refs);
  next.telemetry_refs = uniqueStrings(next.telemetry_refs);
  next.tags = uniqueStrings(next.tags);

  if (!current) {
    entityMap.set(next.id, next);
    return next.id;
  }

  entityMap.set(next.id, {
    ...current,
    ...next,
    label: current.label || next.label,
    status: current.status === "active" ? current.status : (next.status || current.status),
    source_refs: uniqueStrings([...(current.source_refs || []), ...(next.source_refs || [])]),
    story_refs: uniqueStrings([...(current.story_refs || []), ...(next.story_refs || [])]),
    test_refs: uniqueStrings([...(current.test_refs || []), ...(next.test_refs || [])]),
    doc_refs: uniqueStrings([...(current.doc_refs || []), ...(next.doc_refs || [])]),
    telemetry_refs: uniqueStrings([...(current.telemetry_refs || []), ...(next.telemetry_refs || [])]),
    tags: uniqueStrings([...(current.tags || []), ...(next.tags || [])]),
  });
  return next.id;
}

function addRelation(relations, relation) {
  const normalized = {
    ...relation,
    evidence_refs: uniqueStrings(relation.evidence_refs),
  };
  if (relations.some((item) => item.id === normalized.id)) return;
  relations.push(normalized);
}

function addObligation(obligations, obligation) {
  const normalized = {
    ...obligation,
    subject_ids: uniqueStrings(obligation.subject_ids),
    evidence_refs: uniqueStrings(obligation.evidence_refs),
    workflow_targets: uniqueStrings(obligation.workflow_targets),
  };
  if (obligations.some((item) => item.id === normalized.id)) return;
  obligations.push(normalized);
}

function addDriftSignal(driftSignals, signal) {
  const normalized = {
    ...signal,
    subject_ids: uniqueStrings(signal.subject_ids),
    evidence_refs: uniqueStrings(signal.evidence_refs),
  };
  if (driftSignals.some((item) => item.id === normalized.id)) return;
  driftSignals.push(normalized);
}

function addWorkflowEntity(entityMap, workflowsDir, name) {
  const path = join(workflowsDir, `${name}.md`);
  if (!existsSync(path)) return null;
  const id = toId("WORKFLOW", name);
  addEntity(entityMap, {
    id,
    type: "workflow",
    label: `/${name}`,
    surface: "workflow",
    status: "active",
    source_refs: [relPath(path)],
    tags: ["workflow"],
  });
  return id;
}

function createUrlPageEntity(entityMap, url, refs = [], tags = [], status = "active") {
  const value = String(url || "").trim();
  if (!value) return null;
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostPart = parsed.hostname.replace(/^www\./, "");
  const pathPart = parsed.pathname === "/" ? "home" : parsed.pathname.replace(/^\/+|\/+$/g, "");
  const id = toId("PAGE", hostPart, pathPart || "home");
  addEntity(entityMap, {
    id,
    type: "page",
    label: `${parsed.hostname}${parsed.pathname || "/"}`,
    surface: parsed.hostname.startsWith("go.") ? "funnel" : "website",
    status,
    source_refs: refs,
    telemetry_refs: refs.filter((ref) => ref.endsWith(".json")),
    tags,
  });
  return id;
}

function addScopedTokens(target, text, { minLength = 4 } = {}) {
  for (const token of tokenize(text)) {
    if (STOP_TOKENS.has(token) || WEAK_TOKENS.has(token)) continue;
    if (token.length < minLength) continue;
    target.add(token);
  }
}

function extractUrlPathTokens(urls = []) {
  const tokens = [];
  for (const value of urls || []) {
    try {
      const parsed = new URL(String(value || "").trim());
      tokens.push(...tokenize(parsed.pathname));
    } catch {
      // Ignore non-URL input.
    }
  }
  return uniqueStrings(tokens.filter((token) => token.length >= 4 && !STOP_TOKENS.has(token) && !WEAK_TOKENS.has(token)));
}

function buildSemanticMap({ focus, outPath }) {
  const cwd = process.cwd();
  const focusProfile = buildFocusProfile(focus);
  const entityMap = new Map();
  const relations = [];
  const obligations = [];
  const driftSignals = [];
  const selectedFocus = new Set(["planner", "workflow", "docs", "traceability"]);

  const reportsDir = join(cwd, "reports");
  const storyRegistryPath = join(reportsDir, "user_story_audit", "story_registry.json");
  const traceabilityMatrixPath = join(reportsDir, "user_story_audit", "traceability_matrix.md");
  const userStoriesPath = join(cwd, "plans", "knowledge", "USER_STORIES.md");
  const funnelDir = join(cwd, "plans", "knowledge", "funnels");
  const auditConfigPath = join(cwd, "audit.config.json");
  const workflowsDir = join(cwd, ".agent", "workflows");
  const websiteDocsDir = join(cwd, "docs", "user_documents");
  const cmoOutputPath = join(cwd, "cmo_output.json");
  const urlContextPath = join(cwd, "data", "url_context.json");
  const cmoAdvisorPath = join(cwd, "tesseract_operator", "services", "cmo_advisor.py");
  const cmoSkillsPath = join(cwd, "tesseract_operator", "skills", "cmo_skills.py");
  const cmoTestsPath = join(cwd, "tests", "test_cmo_pipeline.py");

  const stewardWorkflowId = addWorkflowEntity(entityMap, workflowsDir, "steward");
  const storyBootstrapWorkflowId = addWorkflowEntity(entityMap, workflowsDir, "story-bootstrap");
  const redTeamStoryWorkflowId = addWorkflowEntity(entityMap, workflowsDir, "red-team-user-story-audit");
  const cmoWorkflowId = addWorkflowEntity(entityMap, workflowsDir, "cmo-advisor");
  const campaignWorkflowId = addWorkflowEntity(entityMap, workflowsDir, "review-campaigns");

  if (cmoWorkflowId || campaignWorkflowId) {
    selectedFocus.add("website");
    selectedFocus.add("funnel");
    selectedFocus.add("campaign");
    selectedFocus.add("telemetry");
  }

  const selectedScopeTokens = new Set(focusProfile.strongTokens || []);
  const selectedChannelTokens = new Set();
  const selectedFunnelIds = [];
  const selectedPageIds = [];
  const selectedHtmlPageIds = [];
  const selectedStoryIds = [];
  const selectedCampaignIds = [];

  if (existsSync(userStoriesPath)) {
    addEntity(entityMap, {
      id: "DOC_USER_STORIES",
      type: "doc",
      label: "Canonical User Stories",
      surface: "docs",
      status: "active",
      source_refs: [relPath(userStoriesPath)],
      tags: ["stories", "canonical"],
    });
  }

  if (existsSync(storyRegistryPath)) {
    addEntity(entityMap, {
      id: "DOC_STORY_REGISTRY",
      type: "doc",
      label: "Story Registry",
      surface: "planner",
      status: "active",
      source_refs: [relPath(storyRegistryPath)],
      tags: ["traceability", "registry"],
    });
  }

  if (existsSync(traceabilityMatrixPath)) {
    addEntity(entityMap, {
      id: "DOC_TRACEABILITY_MATRIX",
      type: "doc",
      label: "Traceability Matrix",
      surface: "planner",
      status: "active",
      source_refs: [relPath(traceabilityMatrixPath)],
      tags: ["traceability", "report"],
    });
  }

  const discoveredFunnelDocs = walkDir(funnelDir, (name) => name.endsWith(".md"))
    .map((path) => {
      const text = readText(path) || "";
      return { path, rel: relPath(path), text, title: markdownTitle(text, basename(path, ".md")) };
    });
  const directFunnelMatches = discoveredFunnelDocs.filter((doc) => textMatchScore(`${doc.title}\n${basename(doc.path, ".md")}`, focusProfile) > 0);
  const fallbackFunnelMatches = discoveredFunnelDocs.filter((doc) => {
    const urlTokens = extractUrlPathTokens(extractUrls(doc.text)).join("\n");
    return textMatchScore(`${doc.title}\n${basename(doc.path, ".md")}\n${urlTokens}`, focusProfile) > 0;
  });
  const funnelDocs = !focusProfile.raw
    ? discoveredFunnelDocs
    : (directFunnelMatches.length > 0 ? directFunnelMatches : fallbackFunnelMatches);

  for (const doc of funnelDocs) {
    selectedFocus.add("funnel");
    selectedFocus.add("docs");
    const slug = basename(doc.path, ".md");
    const docId = toId("DOC", slug);
    const funnelId = toId("FUNNEL", slug);
    const urls = extractUrls(doc.text);
    const docStatus = inferStatusFromText(doc.text, "active");

    addEntity(entityMap, {
      id: docId,
      type: "doc",
      label: doc.title,
      surface: "docs",
      status: "active",
      source_refs: [doc.rel],
      tags: ["funnel_doc", slug],
    });
    addEntity(entityMap, {
      id: funnelId,
      type: "funnel",
      label: doc.title,
      surface: "funnel",
      status: docStatus,
      source_refs: [doc.rel],
      doc_refs: [doc.rel],
      tags: [slug],
    });
    addRelation(relations, {
      id: toId("REL", docId, "DOCUMENTS", funnelId),
      type: "documents",
      from: docId,
      to: funnelId,
      confidence: "high",
      evidence_refs: [doc.rel],
    });
    selectedFunnelIds.push(funnelId);
    addScopedTokens(selectedScopeTokens, `${doc.title} ${slug}`);
    for (const token of extractUrlPathTokens(urls)) selectedScopeTokens.add(token);
    if (/facebook ads|fb ads/i.test(doc.text)) {
      for (const token of CHANNEL_HINT_TOKENS) selectedChannelTokens.add(token);
      const campaignId = toId("CAMPAIGN", "FB", slug);
      addEntity(entityMap, {
        id: campaignId,
        type: "campaign",
        label: `${doc.title} Facebook Ads`,
        surface: "campaign",
        status: inferStatusFromText(doc.text, "draft"),
        source_refs: [doc.rel],
        doc_refs: [doc.rel],
        tags: ["facebook_ads", slug],
      });
      selectedCampaignIds.push(campaignId);
      selectedFocus.add("campaign");
      if (urls.length > 0) {
        const primaryUrl = urls[0];
        const pageId = createUrlPageEntity(entityMap, primaryUrl, [doc.rel], [slug], "active");
        if (pageId) {
          selectedPageIds.push(pageId);
          addRelation(relations, {
            id: toId("REL", campaignId, "DRIVES", pageId),
            type: "drives_traffic_to",
            from: campaignId,
            to: pageId,
            confidence: "high",
            evidence_refs: [doc.rel],
          });
        }
      }
    }
    for (const url of urls) {
      const pageId = createUrlPageEntity(entityMap, url, [doc.rel], [slug], "active");
      if (!pageId) continue;
      selectedPageIds.push(pageId);
      addRelation(relations, {
        id: toId("REL", funnelId, "CONTAINS", pageId),
        type: "contains",
        from: funnelId,
        to: pageId,
        confidence: "high",
        evidence_refs: [doc.rel],
      });
    }
  }

  const discoveredWebsiteAssets = walkDir(websiteDocsDir, (name) => name.endsWith(".html"))
    .map((path) => {
      const text = readText(path) || "";
      return {
        path,
        rel: relPath(path),
        text,
        title: extractHtmlTitle(text, basename(path, ".html")),
      };
    });
  const directWebsiteMatches = discoveredWebsiteAssets.filter((asset) => textMatchScore(`${asset.title}\n${basename(asset.path, ".html")}`, focusProfile, [...selectedScopeTokens]) > 0);
  const fallbackWebsiteMatches = discoveredWebsiteAssets.filter((asset) => {
    const extraTokens = [...selectedScopeTokens, ...selectedChannelTokens];
    return textMatchScore(`${asset.title}\n${asset.text}\n${asset.rel}`, focusProfile, extraTokens) > 0;
  });
  const websiteAssets = !focusProfile.raw
    ? discoveredWebsiteAssets
    : (directWebsiteMatches.length > 0 ? directWebsiteMatches : fallbackWebsiteMatches);

  for (const asset of websiteAssets) {
    selectedFocus.add("website");
    const pageId = toId("PAGE", basename(asset.path, ".html"));
    addEntity(entityMap, {
      id: pageId,
      type: "page",
      label: asset.title,
      surface: "website",
      status: "draft",
      source_refs: [asset.rel],
      tags: ["website_asset", basename(dirname(asset.path)), basename(asset.path, ".html")],
    });
    selectedHtmlPageIds.push(pageId);
    if (selectedFunnelIds.length > 0) {
      addRelation(relations, {
        id: toId("REL", selectedFunnelIds[0], "CONTAINS", pageId),
        type: "contains",
        from: selectedFunnelIds[0],
        to: pageId,
        confidence: "low",
        evidence_refs: [asset.rel, entityMap.get(selectedFunnelIds[0])?.source_refs?.[0]].filter(Boolean),
      });
    }

    if (detectPlaceholderCta(asset.text)) {
      const findingId = toId("FINDING", basename(asset.path, ".html"), "CTA", "PLACEHOLDER");
      addEntity(entityMap, {
        id: findingId,
        type: "finding",
        label: `${asset.title} uses placeholder CTA targets`,
        surface: "website",
        status: "active",
        source_refs: [asset.rel],
        tags: ["cta", "placeholder_href"],
      });
      addRelation(relations, {
        id: toId("REL", findingId, "ISSUE", pageId),
        type: "finds_issue_in",
        from: findingId,
        to: pageId,
        confidence: "high",
        evidence_refs: [asset.rel],
      });
      addObligation(obligations, {
        id: toId("OBL", pageId, "CTA_WIRING"),
        type: "cta_wiring",
        status: "open",
        subject_ids: [pageId, findingId],
        gap: `${asset.title} still contains href="#" placeholder CTA targets, so the page does not yet express a real conversion path.`,
        evidence_refs: [asset.rel],
        workflow_targets: [".agent/workflows/steward.md", ".agent/workflows/cmo-advisor.md"].filter((target) => existsSync(join(cwd, target))),
      });
    }
  }

  const cmoOutput = loadJson(cmoOutputPath);
  for (const token of extractUrlPathTokens([extractTargetUrlFromCmoOutput(cmoOutput)])) selectedScopeTokens.add(token);

  const storyRegistry = loadJson(storyRegistryPath);
  const registryStories = Array.isArray(storyRegistry?.stories) ? storyRegistry.stories : [];
  const storyTokens = uniqueStrings([...selectedScopeTokens, ...selectedChannelTokens]);
  const directStoryMatches = registryStories.filter((story) => textMatchScore(`${story.id}\n${story.title}`, focusProfile, storyTokens) > 0);
  const fallbackStoryMatches = registryStories.filter((story) => {
    const storyText = [
      story.id,
      story.title,
      ...(story.doc_refs || []),
      ...(story.code_refs || []),
      ...(story.test_refs || []),
    ].join("\n");
    return textMatchScore(storyText, focusProfile, storyTokens) > 0;
  });
  const scopedStories = !focusProfile.raw
    ? registryStories
    : (directStoryMatches.length > 0 ? directStoryMatches : fallbackStoryMatches);

  for (const story of scopedStories) {
    const storyText = [
      story.id,
      story.title,
      ...(story.doc_refs || []),
      ...(story.code_refs || []),
      ...(story.test_refs || []),
    ].join("\n");

    const storyId = toId("STORY", String(story.id || "").replace(/[^A-Za-z0-9]+/g, "_"));
    addEntity(entityMap, {
      id: storyId,
      type: "story",
      label: `${story.id} ${story.title}`.trim(),
      surface: "planner",
      status: "active",
      source_refs: [relPath(storyRegistryPath), ...(story.doc_refs || [])],
      doc_refs: uniqueStrings(story.doc_refs),
      test_refs: uniqueStrings(story.test_refs),
      story_refs: [String(story.id || "")].filter(Boolean),
      tags: uniqueStrings(tokenize(story.title || "").filter((token) => token.length >= 4)),
    });
    selectedStoryIds.push(storyId);

    if (story.id && existsSync(userStoriesPath)) {
      addRelation(relations, {
        id: toId("REL", "DOC_USER_STORIES", "DOCUMENTS", storyId),
        type: "documents",
        from: "DOC_USER_STORIES",
        to: storyId,
        confidence: "medium",
        evidence_refs: [relPath(userStoriesPath)],
      });
    }
    addRelation(relations, {
      id: toId("REL", "DOC_STORY_REGISTRY", "DOCUMENTS", storyId),
      type: "documents",
      from: "DOC_STORY_REGISTRY",
      to: storyId,
      confidence: "high",
      evidence_refs: [relPath(storyRegistryPath)],
    });

    const storyEvidence = buildStoryEvidenceReport(story, storyRegistry, cwd);
    if (story.status === "FULLY_COVERED" && !storyEvidence.evidence_ready) {
      const issueSummary = storyEvidence.issues.map((issue) => issue.message).join("; ");
      addObligation(obligations, {
        id: toId("OBL", storyId, "TEST_LINK"),
        type: "test_link",
        status: "open",
        subject_ids: [storyId, "DOC_STORY_REGISTRY"],
        gap: `${story.id} is marked FULLY_COVERED but its canonical evidence contract fails: ${issueSummary}`,
        evidence_refs: [relPath(storyRegistryPath)],
        workflow_targets: [".agent/workflows/steward.md", ".agent/workflows/red-team-user-story-audit.md"].filter((target) => existsSync(join(cwd, target))),
      });
      addDriftSignal(driftSignals, {
        id: toId("DRIFT", storyId, "COVERAGE"),
        category: "coverage_drift",
        severity: "high",
        subject_ids: [storyId, "DOC_STORY_REGISTRY"],
        detail: `${story.id} is marked FULLY_COVERED even though canonical registry validation rejects its evidence chain: ${issueSummary}`,
        evidence_refs: [relPath(storyRegistryPath)],
      });
    }
  }

  for (const funnelId of selectedFunnelIds) {
    for (const storyId of selectedStoryIds) {
      addRelation(relations, {
        id: toId("REL", funnelId, "LINKS", storyId),
        type: "links_to_story",
        from: funnelId,
        to: storyId,
        confidence: "medium",
        evidence_refs: [entityMap.get(funnelId)?.source_refs?.[0], relPath(storyRegistryPath)].filter(Boolean),
      });
    }
  }

  for (const campaignId of selectedCampaignIds) {
    for (const storyId of selectedStoryIds) {
      addRelation(relations, {
        id: toId("REL", campaignId, "LINKS", storyId),
        type: "links_to_story",
        from: campaignId,
        to: storyId,
        confidence: "medium",
        evidence_refs: [entityMap.get(campaignId)?.source_refs?.[0], relPath(storyRegistryPath)].filter(Boolean),
      });
    }
  }

  if (selectedHtmlPageIds.length > 0) {
    const orphanedPages = selectedHtmlPageIds.filter((pageId) => {
      if (relations.some((relation) => relation.type === "links_to_story" && relation.from === pageId)) return false;
      const parentIds = relations
        .filter((relation) => relation.type === "contains" && relation.to === pageId)
        .map((relation) => relation.from);
      return !parentIds.some((parentId) => relations.some((relation) => relation.type === "links_to_story" && relation.from === parentId));
    });
    if (orphanedPages.length > 0) {
      addObligation(obligations, {
        id: "OBL_WEBSITE_STORY_LINK",
        type: "story_link",
        status: "open",
        subject_ids: [...orphanedPages, "DOC_STORY_REGISTRY"],
        gap: "Website assets are present for the selected scope, but they are not yet durably linked to explicit story entries in the registry.",
        evidence_refs: orphanedPages.flatMap((pageId) => entityMap.get(pageId)?.source_refs || []).concat(relPath(storyRegistryPath)),
        workflow_targets: [".agent/workflows/steward.md", ".agent/workflows/story-bootstrap.md"].filter((target) => existsSync(join(cwd, target))),
      });
      addDriftSignal(driftSignals, {
        id: "DRIFT_WEBSITE_STORY_LINKS",
        category: "story_gap",
        severity: "high",
        subject_ids: [...orphanedPages, "DOC_STORY_REGISTRY"],
        detail: "Selected website assets exist as maintained files, but they are not represented as first-class story-linked surfaces in the registry.",
        evidence_refs: orphanedPages.flatMap((pageId) => entityMap.get(pageId)?.source_refs || []).concat(relPath(storyRegistryPath)),
      });
    }
  }

  const urlContext = loadJson(urlContextPath);
  if (cmoOutput) {
    selectedFocus.add("telemetry");
    const targetUrl = extractTargetUrlFromCmoOutput(cmoOutput);
    const telemetryEntityId = "TELEMETRY_CMO_OUTPUT";
    addEntity(entityMap, {
      id: telemetryEntityId,
      type: "telemetry_artifact",
      label: "CMO Advisory Output",
      surface: "telemetry",
      status: cmoOutput.context_found === false ? "stale" : "active",
      source_refs: [relPath(cmoOutputPath)],
      telemetry_refs: [relPath(cmoOutputPath)],
      tags: ["cmo_output"],
    });

    const telemetryBlock = extractTelemetryBlock(cmoOutput);
    const pageId = targetUrl ? createUrlPageEntity(entityMap, targetUrl, [relPath(cmoOutputPath)], ["cmo_target"], cmoOutput.context_found === false ? "stale" : "active") : null;
    if (pageId) {
      selectedPageIds.push(pageId);
      addRelation(relations, {
        id: toId("REL", telemetryEntityId, "MEASURES", pageId),
        type: "measures",
        from: telemetryEntityId,
        to: pageId,
        confidence: "high",
        evidence_refs: [relPath(cmoOutputPath)],
      });
      if (cmoWorkflowId) {
        addRelation(relations, {
          id: toId("REL", cmoWorkflowId, "AUDITS", pageId),
          type: "audits",
          from: cmoWorkflowId,
          to: pageId,
          confidence: "high",
          evidence_refs: [".agent/workflows/cmo-advisor.md", relPath(cmoOutputPath)].filter((ref) => existsSync(join(cwd, ref))),
        });
      }
    }

    const personaKeys = ["content_strategist", "ad_optimizer", "pipeline_analyst"];
    for (const key of personaKeys) {
      if (!cmoOutput[key]) continue;
      const personaId = toId("PERSONA", key);
      addEntity(entityMap, {
        id: personaId,
        type: "persona",
        label: key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
        surface: "workflow",
        status: "active",
        source_refs: [relPath(cmoOutputPath)],
        tags: ["cmo", key],
      });
      if (cmoWorkflowId) {
        addRelation(relations, {
          id: toId("REL", personaId, "OWNS", cmoWorkflowId),
          type: "owns",
          from: personaId,
          to: cmoWorkflowId,
          confidence: "medium",
          evidence_refs: [relPath(cmoOutputPath), ".agent/workflows/cmo-advisor.md"].filter((ref) => existsSync(join(cwd, ref))),
        });
      }
    }

    const normalizedTargetUrl = String(targetUrl || "").replace(/\/+$/, "").toLowerCase();
    const urlContextUrls = urlContext && typeof urlContext === "object" ? (urlContext.urls || urlContext) : {};
    const contextKeys = Object.keys(urlContextUrls || {});
    const contextFoundInCache = normalizedTargetUrl
      ? contextKeys.some((key) => String(key).replace(/\/+$/, "").toLowerCase() === normalizedTargetUrl)
      : false;
    const telemetryEmpty = telemetryBlock && Object.keys(telemetryBlock).length === 0;

    if (existsSync(urlContextPath)) {
      addEntity(entityMap, {
        id: "TELEMETRY_URL_CONTEXT",
        type: "telemetry_artifact",
        label: "Joined URL Context Cache",
        surface: "telemetry",
        status: contextFoundInCache ? "active" : "stale",
        source_refs: [relPath(urlContextPath)],
        telemetry_refs: [relPath(urlContextPath)],
        tags: ["url_context"],
      });
      if (pageId) {
        addRelation(relations, {
          id: toId("REL", "TELEMETRY_URL_CONTEXT", "MEASURES", pageId),
          type: "measures",
          from: "TELEMETRY_URL_CONTEXT",
          to: pageId,
          confidence: contextFoundInCache ? "high" : "medium",
          evidence_refs: [relPath(urlContextPath)],
        });
      }
    }

    if (cmoOutput.context_found === false || telemetryEmpty || (targetUrl && !contextFoundInCache)) {
      const findingId = "FINDING_CMO_UNGROUNDED";
      addEntity(entityMap, {
        id: findingId,
        type: "finding",
        label: "CMO advisory output is ungrounded for the selected page",
        surface: "telemetry",
        status: "active",
        source_refs: [relPath(cmoOutputPath), ...(existsSync(urlContextPath) ? [relPath(urlContextPath)] : [])],
        telemetry_refs: [relPath(cmoOutputPath), ...(existsSync(urlContextPath) ? [relPath(urlContextPath)] : [])],
        tags: ["context_found_false", "ungrounded"],
      });
      if (pageId) {
        addRelation(relations, {
          id: toId("REL", findingId, "ISSUE", pageId),
          type: "finds_issue_in",
          from: findingId,
          to: pageId,
          confidence: "high",
          evidence_refs: [relPath(cmoOutputPath), ...(existsSync(urlContextPath) ? [relPath(urlContextPath)] : [])],
        });
      }
      addObligation(obligations, {
        id: "OBL_TELEMETRY_GROUNDING",
        type: "telemetry_grounding",
        status: "open",
        subject_ids: uniqueStrings([pageId, telemetryEntityId, "TELEMETRY_URL_CONTEXT", findingId]),
        gap: "The CMO advisory output was produced without grounded telemetry for the selected target URL.",
        evidence_refs: [relPath(cmoOutputPath), ...(existsSync(urlContextPath) ? [relPath(urlContextPath)] : [])],
        workflow_targets: [".agent/workflows/steward.md", ".agent/workflows/cmo-advisor.md"].filter((target) => existsSync(join(cwd, target))),
      });
      addDriftSignal(driftSignals, {
        id: "DRIFT_TELEMETRY_GAP",
        category: "telemetry_gap",
        severity: "critical",
        subject_ids: uniqueStrings([pageId, telemetryEntityId, "TELEMETRY_URL_CONTEXT"]),
        detail: "The target URL used by the CMO advisory is missing or ungrounded in joined telemetry, so the advisory can score a page without real context.",
        evidence_refs: [relPath(cmoOutputPath), ...(existsSync(urlContextPath) ? [relPath(urlContextPath)] : [])],
      });
    }
  }

  const canonicalCategories = extractCategoriesFromText(readText(cmoAdvisorPath));
  const skillCategories = extractCategoriesFromText(readText(cmoSkillsPath));
  const promptCategories = extractCategoriesFromText(String(cmoOutput?.advisory_prompt || ""));
  if (canonicalCategories.length > 0) {
    addEntity(entityMap, {
      id: "RULE_CMO_FINDING_TAXONOMY",
      type: "rule",
      label: "Canonical CMO Finding Taxonomy",
      surface: "ontology",
      status: "active",
      source_refs: [relPath(cmoAdvisorPath), ...(existsSync(cmoTestsPath) ? [relPath(cmoTestsPath)] : [])],
      tags: ["finding_taxonomy"],
    });
    if (existsSync(cmoTestsPath)) {
      addEntity(entityMap, {
        id: "TEST_CMO_PIPELINE",
        type: "test",
        label: "CMO pipeline tests",
        surface: "tests",
        status: "active",
        source_refs: [relPath(cmoTestsPath)],
        tags: ["cmo", "taxonomy"],
      });
      addRelation(relations, {
        id: "REL_TEST_CMO_VALIDATES_TAXONOMY",
        type: "validates",
        from: "TEST_CMO_PIPELINE",
        to: "RULE_CMO_FINDING_TAXONOMY",
        confidence: "high",
        evidence_refs: [relPath(cmoTestsPath), relPath(cmoAdvisorPath)],
      });
    }
  }

  const taxonomyMismatch = canonicalCategories.length > 0 && (
    (skillCategories.length > 0 && canonicalCategories.join("|") !== skillCategories.join("|")) ||
    (promptCategories.length > 0 && canonicalCategories.join("|") !== promptCategories.join("|"))
  );
  if (taxonomyMismatch) {
    const findingId = "FINDING_TAXONOMY_DRIFT";
    addEntity(entityMap, {
      id: findingId,
      type: "finding",
      label: "CMO prompt taxonomy drifts from canonical enum",
      surface: "workflow",
      status: "active",
      source_refs: uniqueStrings([relPath(cmoAdvisorPath), ...(existsSync(cmoSkillsPath) ? [relPath(cmoSkillsPath)] : []), ...(existsSync(cmoOutputPath) ? [relPath(cmoOutputPath)] : [])]),
      tags: ["taxonomy_drift"],
    });
    addRelation(relations, {
      id: "REL_TAXONOMY_FINDING_RULE",
      type: "finds_issue_in",
      from: findingId,
      to: "RULE_CMO_FINDING_TAXONOMY",
      confidence: "high",
      evidence_refs: uniqueStrings([relPath(cmoAdvisorPath), ...(existsSync(cmoSkillsPath) ? [relPath(cmoSkillsPath)] : []), ...(existsSync(cmoOutputPath) ? [relPath(cmoOutputPath)] : [])]),
    });
    addObligation(obligations, {
      id: "OBL_TAXONOMY_SYNC",
      type: "taxonomy_sync",
      status: "open",
      subject_ids: uniqueStrings(["RULE_CMO_FINDING_TAXONOMY", findingId, "TELEMETRY_CMO_OUTPUT"]),
      gap: "The canonical CMO finding taxonomy differs from one or more prompt or workflow surfaces.",
      evidence_refs: uniqueStrings([relPath(cmoAdvisorPath), ...(existsSync(cmoSkillsPath) ? [relPath(cmoSkillsPath)] : []), ...(existsSync(cmoOutputPath) ? [relPath(cmoOutputPath)] : []), ...(existsSync(cmoTestsPath) ? [relPath(cmoTestsPath)] : [])]),
      workflow_targets: [".agent/workflows/steward.md", ".agent/workflows/cmo-advisor.md"].filter((target) => existsSync(join(cwd, target))),
    });
    addDriftSignal(driftSignals, {
      id: "DRIFT_TAXONOMY",
      category: "taxonomy_drift",
      severity: "high",
      subject_ids: uniqueStrings(["RULE_CMO_FINDING_TAXONOMY", findingId, "TELEMETRY_CMO_OUTPUT"]),
      detail: "Canonical CMO finding categories and downstream prompt surfaces no longer agree.",
      evidence_refs: uniqueStrings([relPath(cmoAdvisorPath), ...(existsSync(cmoSkillsPath) ? [relPath(cmoSkillsPath)] : []), ...(existsSync(cmoOutputPath) ? [relPath(cmoOutputPath)] : []), ...(existsSync(cmoTestsPath) ? [relPath(cmoTestsPath)] : [])]),
    });
  }

  const traceabilityMatrix = readText(traceabilityMatrixPath);
  if (traceabilityMatrix && traceabilityMatrix.includes("docs/USER_STORIES.md") && existsSync(userStoriesPath)) {
    addObligation(obligations, {
      id: "OBL_DOC_SYNC_STORY_PATH",
      type: "doc_sync",
      status: "open",
      subject_ids: uniqueStrings(["DOC_USER_STORIES", "DOC_TRACEABILITY_MATRIX"]),
      gap: "Traceability artifacts still reference docs/USER_STORIES.md even though the maintained story source lives under plans/knowledge/USER_STORIES.md.",
      evidence_refs: [relPath(traceabilityMatrixPath), relPath(userStoriesPath)],
      workflow_targets: [".agent/workflows/steward.md"].filter((target) => existsSync(join(cwd, target))),
    });
    addDriftSignal(driftSignals, {
      id: "DRIFT_DOC_STORY_PATH",
      category: "doc_drift",
      severity: "medium",
      subject_ids: uniqueStrings(["DOC_USER_STORIES", "DOC_TRACEABILITY_MATRIX"]),
      detail: "Story path references have drifted between the canonical story source and traceability outputs.",
      evidence_refs: [relPath(traceabilityMatrixPath), relPath(userStoriesPath)],
    });
  }

  const auditConfig = loadJson(auditConfigPath);
  const roles = Array.isArray(auditConfig?.roles) ? auditConfig.roles : [];
  if ((selectedFocus.has("website") || selectedFocus.has("campaign") || selectedFocus.has("telemetry")) && roles.length > 0 && roles.every((role) => String(role).toLowerCase() === "core")) {
    const personaCoverageSubjects = uniqueStrings([
      stewardWorkflowId,
      cmoWorkflowId,
      ...selectedFunnelIds,
      ...selectedCampaignIds,
      ...selectedPageIds,
    ].filter(Boolean));
    addObligation(obligations, {
      id: "OBL_PERSONA_COVERAGE",
      type: "persona_coverage",
      status: "open",
      subject_ids: personaCoverageSubjects,
      gap: "The host repo now has website, funnel, or campaign semantic surfaces, but audit.config.json still limits planner audits to the core pack only.",
      evidence_refs: [relPath(auditConfigPath)],
      workflow_targets: [".agent/workflows/steward.md"].filter((target) => existsSync(join(cwd, target))),
    });
    addDriftSignal(driftSignals, {
      id: "DRIFT_PERSONA_SCOPE",
      category: "persona_gap",
      severity: "medium",
      subject_ids: personaCoverageSubjects,
      detail: "Semantic surfaces now exceed the current planner persona coverage declared in audit.config.json.",
      evidence_refs: [relPath(auditConfigPath)],
    });
  }

  if (stewardWorkflowId && (cmoWorkflowId || campaignWorkflowId || storyBootstrapWorkflowId || redTeamStoryWorkflowId)) {
    const subjectIds = uniqueStrings([stewardWorkflowId, cmoWorkflowId, campaignWorkflowId, storyBootstrapWorkflowId, redTeamStoryWorkflowId].filter(Boolean));
    addObligation(obligations, {
      id: "OBL_WORKFLOW_DISPATCH",
      type: "workflow_dispatch",
      status: "satisfied",
      subject_ids: subjectIds,
      gap: "The semantic map identifies the parent stewardship workflow plus the specialist follow-ups it may dispatch for this surface.",
      evidence_refs: uniqueStrings(subjectIds.map((id) => entityMap.get(id)?.source_refs?.[0]).filter(Boolean)),
      workflow_targets: uniqueStrings(subjectIds.map((id) => entityMap.get(id)?.source_refs?.[0]).filter(Boolean)),
    });
  }

  if (selectedPageIds.length === 0 && selectedHtmlPageIds.length > 0) selectedFocus.add("website");
  if (selectedStoryIds.length > 0) selectedFocus.add("traceability");
  if (selectedFunnelIds.length > 0) selectedFocus.add("funnel");
  if (selectedCampaignIds.length > 0) selectedFocus.add("campaign");
  if (existsSync(cmoOutputPath) || existsSync(urlContextPath)) selectedFocus.add("telemetry");

  const entityList = [...entityMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const groundedEntities = entityList.filter((entity) => entity.status === "active" || entity.status === "draft").length;
  const openObligations = obligations.filter((obligation) => obligation.status === "open" || obligation.status === "in_progress").length;

  const goalSource = funnelDocs[0]?.rel || relPath(outPath);
  const goalSummary = funnelDocs[0]
    ? `Consolidate the ${funnelDocs[0].title} semantic surfaces so stewardship can detect drift, document changes semantically, and dispatch the right workflow.`
    : `Consolidate semantic surfaces for ${focusProfile.raw || "the selected project scope"} so stewardship can detect drift and document changes semantically.`;

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    goal_anchor: {
      source: goalSource,
      summary: goalSummary,
      intent_ref: focusProfile.raw || null,
    },
    focus: [...selectedFocus].filter((value) => FOCUS_VALUES.has(value)),
    entities: entityList,
    relations: relations.sort((a, b) => a.id.localeCompare(b.id)),
    obligations: obligations.sort((a, b) => a.id.localeCompare(b.id)),
    drift_signals: driftSignals.sort((a, b) => a.id.localeCompare(b.id)),
    coverage_summary: {
      entity_count: entityList.length,
      relation_count: relations.length,
      open_obligations: openObligations,
      grounded_entities: groundedEntities,
    },
  };
}

function validateSemanticMap(map) {
  const errors = [];
  const schema = loadJson(SCHEMA_PATH) || {};
  const requiredTopLevel = schema.required || ["version", "generated_at", "goal_anchor", "focus", "entities", "relations", "obligations"];

  for (const key of requiredTopLevel) {
    if (!(key in map)) errors.push(`Missing top-level key: ${key}`);
  }
  if (map.version !== 1) errors.push("version must equal 1");
  if (!map.generated_at || Number.isNaN(Date.parse(map.generated_at))) errors.push("generated_at must be an ISO date-time");
  if (!map.goal_anchor || typeof map.goal_anchor !== "object") {
    errors.push("goal_anchor must be an object");
  } else {
    if (!map.goal_anchor.source) errors.push("goal_anchor.source is required");
    if (!map.goal_anchor.summary) errors.push("goal_anchor.summary is required");
  }
  if (!Array.isArray(map.focus) || map.focus.length === 0) {
    errors.push("focus must be a non-empty array");
  } else {
    for (const value of map.focus) {
      if (!FOCUS_VALUES.has(value)) errors.push(`focus contains invalid value: ${value}`);
    }
  }
  if (!Array.isArray(map.entities)) errors.push("entities must be an array");
  if (!Array.isArray(map.relations)) errors.push("relations must be an array");
  if (!Array.isArray(map.obligations)) errors.push("obligations must be an array");

  const entityIds = new Set();
  for (const entity of map.entities || []) {
    if (!entity.id || !/^[A-Z0-9_-]+$/.test(entity.id)) errors.push(`entity id is invalid: ${entity.id}`);
    if (entityIds.has(entity.id)) errors.push(`duplicate entity id: ${entity.id}`);
    entityIds.add(entity.id);
    if (!ENTITY_TYPES.has(entity.type)) errors.push(`entity ${entity.id} has invalid type: ${entity.type}`);
    if (!ENTITY_SURFACES.has(entity.surface)) errors.push(`entity ${entity.id} has invalid surface: ${entity.surface}`);
    if (!ENTITY_STATUSES.has(entity.status)) errors.push(`entity ${entity.id} has invalid status: ${entity.status}`);
    if (!Array.isArray(entity.source_refs)) errors.push(`entity ${entity.id} source_refs must be an array`);
  }

  for (const relation of map.relations || []) {
    if (!RELATION_TYPES.has(relation.type)) errors.push(`relation ${relation.id} has invalid type: ${relation.type}`);
    if (relation.confidence && !RELATION_CONFIDENCE.has(relation.confidence)) errors.push(`relation ${relation.id} has invalid confidence: ${relation.confidence}`);
    if (!entityIds.has(relation.from)) errors.push(`relation ${relation.id} references unknown from entity: ${relation.from}`);
    if (!entityIds.has(relation.to)) errors.push(`relation ${relation.id} references unknown to entity: ${relation.to}`);
  }

  for (const obligation of map.obligations || []) {
    if (!OBLIGATION_TYPES.has(obligation.type)) errors.push(`obligation ${obligation.id} has invalid type: ${obligation.type}`);
    if (!OBLIGATION_STATUS.has(obligation.status)) errors.push(`obligation ${obligation.id} has invalid status: ${obligation.status}`);
    if (!Array.isArray(obligation.subject_ids) || obligation.subject_ids.length === 0) errors.push(`obligation ${obligation.id} must have subject_ids`);
    for (const subjectId of obligation.subject_ids || []) {
      if (!entityIds.has(subjectId)) errors.push(`obligation ${obligation.id} references unknown subject: ${subjectId}`);
    }
  }

  for (const signal of map.drift_signals || []) {
    if (!DRIFT_CATEGORIES.has(signal.category)) errors.push(`drift signal ${signal.id} has invalid category: ${signal.category}`);
    if (!DRIFT_SEVERITY.has(signal.severity)) errors.push(`drift signal ${signal.id} has invalid severity: ${signal.severity}`);
    for (const subjectId of signal.subject_ids || []) {
      if (!entityIds.has(subjectId)) errors.push(`drift signal ${signal.id} references unknown subject: ${subjectId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      entities: (map.entities || []).length,
      relations: (map.relations || []).length,
      obligations: (map.obligations || []).length,
      drift_signals: (map.drift_signals || []).length,
    },
  };
}

function cmdGenerate(options) {
  const outPath = resolve(process.cwd(), options.out || DEFAULT_OUT);
  const map = buildSemanticMap({ focus: options.focus, outPath });
  ensureDir(dirname(outPath));
  writeFileSync(outPath, JSON.stringify(map, null, 2) + "\n");
  const validation = validateSemanticMap(map);
  if (!validation.ok) {
    console.error("ERROR: generated semantic map failed validation:");
    for (const error of validation.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  if (options.json) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }
  console.log(`GENERATED ${relPath(outPath)}`);
  console.log(`  Entities: ${validation.counts.entities}`);
  console.log(`  Relations: ${validation.counts.relations}`);
  console.log(`  Obligations: ${validation.counts.obligations}`);
  console.log(`  Drift signals: ${validation.counts.drift_signals}`);
}

function cmdCheck(filePath, options) {
  const target = resolve(process.cwd(), filePath || DEFAULT_OUT);
  if (!existsSync(target)) {
    console.error(`ERROR: semantic map not found: ${target}`);
    process.exit(1);
  }
  const map = loadJson(target);
  if (!map) {
    console.error(`ERROR: invalid JSON: ${target}`);
    process.exit(1);
  }
  const validation = validateSemanticMap(map);
  if (options.json) {
    console.log(JSON.stringify({
      status: validation.ok ? "PASS" : "FAIL",
      file: relPath(target),
      errors: validation.errors,
      counts: validation.counts,
    }, null, 2));
  } else if (validation.ok) {
    console.log(`PASS ${relPath(target)} (${validation.counts.entities} entities, ${validation.counts.obligations} obligations)`);
  } else {
    console.log(`FAIL ${relPath(target)}`);
    for (const error of validation.errors) console.log(`- ${error}`);
  }
  process.exit(validation.ok ? 0 : 1);
}

function cmdSummary(filePath, options) {
  const target = resolve(process.cwd(), filePath || DEFAULT_OUT);
  if (!existsSync(target)) {
    console.error(`ERROR: semantic map not found: ${target}`);
    process.exit(1);
  }
  const map = loadJson(target);
  if (!map) {
    console.error(`ERROR: invalid JSON: ${target}`);
    process.exit(1);
  }
  const open = (map.obligations || []).filter((item) => item.status === "open" || item.status === "in_progress");
  const criticalDrift = (map.drift_signals || []).filter((item) => item.severity === "critical" || item.severity === "high");
  if (options.json) {
    console.log(JSON.stringify({
      file: relPath(target),
      focus: map.focus || [],
      counts: map.coverage_summary || {},
      open_obligations: open.map((item) => ({ id: item.id, type: item.type, gap: item.gap })),
      high_drift: criticalDrift.map((item) => ({ id: item.id, category: item.category, detail: item.detail })),
    }, null, 2));
    return;
  }
  console.log(`Semantic map: ${relPath(target)}`);
  console.log(`  Focus: ${(map.focus || []).join(", ") || "(none)"}`);
  console.log(`  Entities: ${map.coverage_summary?.entity_count ?? (map.entities || []).length}`);
  console.log(`  Relations: ${map.coverage_summary?.relation_count ?? (map.relations || []).length}`);
  console.log(`  Open obligations: ${open.length}`);
  console.log(`  High drift signals: ${criticalDrift.length}`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = { json: false, focus: "", out: DEFAULT_OUT };
  const positionals = [];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--focus") {
      options.focus = args.shift() || "";
    } else if (arg === "--out") {
      options.out = args.shift() || DEFAULT_OUT;
    } else {
      positionals.push(arg);
    }
  }
  return { options, positionals };
}

const { options, positionals } = parseArgs(process.argv.slice(2));
const command = positionals[0];

if (!command || command === "--help" || command === "help") {
  usage();
  process.exit(0);
}

if (command === "generate") {
  cmdGenerate(options);
} else if (command === "check") {
  cmdCheck(positionals[1], options);
} else if (command === "summary") {
  cmdSummary(positionals[1], options);
} else {
  console.error(`ERROR: Unknown command "${command}".`);
  usage();
  process.exit(1);
}
