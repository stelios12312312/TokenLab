import verificationStatusVocabularySource from "../../config/verification_status_vocabulary.json" with { type: "json" };

const DEFAULT_VOCABULARY_PATH = ".agent/skills/iterative-planner/config/verification_status_vocabulary.json";
const NORMALIZATION_MODES = new Set(["presentation", "identifier"]);

let cachedVocabulary = null;

function presentationToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/^[`*_~]+|[`*_~]+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function identifierToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeToken(value, mode) {
  return mode === "presentation" ? presentationToken(value) : identifierToken(value);
}

function assertString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`verification_status_vocabulary_invalid:${path}_must_be_non_empty_string`);
  }
  return value.trim();
}

function validateVocabulary(raw, sourcePath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`verification_status_vocabulary_invalid:${sourcePath}:root_must_be_object`);
  }
  if (raw.schema_version !== 1) {
    throw new Error(`verification_status_vocabulary_invalid:${sourcePath}:unsupported_schema_version`);
  }
  if (!raw.contexts || typeof raw.contexts !== "object" || Array.isArray(raw.contexts)) {
    throw new Error(`verification_status_vocabulary_invalid:${sourcePath}:contexts_must_be_object`);
  }

  const contexts = {};
  for (const [contextName, context] of Object.entries(raw.contexts)) {
    const name = assertString(contextName, "context_name");
    const mode = assertString(context?.normalization, `${name}.normalization`);
    if (!NORMALIZATION_MODES.has(mode)) {
      throw new Error(`verification_status_vocabulary_invalid:${name}.normalization_unknown:${mode}`);
    }
    if (!Array.isArray(context?.statuses) || context.statuses.length === 0) {
      throw new Error(`verification_status_vocabulary_invalid:${name}.statuses_must_be_non_empty_array`);
    }

    const seenForms = new Map();
    const seenCanonicals = new Set();
    const statuses = context.statuses.map((status, index) => {
      const canonical = assertString(status?.canonical, `${name}.statuses[${index}].canonical`);
      const kind = assertString(status?.kind, `${name}.statuses[${index}].kind`);
      if (typeof status?.satisfies !== "boolean") {
        throw new Error(`verification_status_vocabulary_invalid:${name}.statuses[${index}].satisfies_must_be_boolean`);
      }
      if (!Array.isArray(status?.forms) || status.forms.length === 0) {
        throw new Error(`verification_status_vocabulary_invalid:${name}.statuses[${index}].forms_must_be_non_empty_array`);
      }
      const canonicalKey = normalizeToken(canonical, mode);
      if (!canonicalKey || seenCanonicals.has(canonicalKey)) {
        throw new Error(`verification_status_vocabulary_invalid:${name}.duplicate_canonical:${canonical}`);
      }
      seenCanonicals.add(canonicalKey);

      const forms = status.forms.map((form, formIndex) => {
        const authored = assertString(form, `${name}.statuses[${index}].forms[${formIndex}]`);
        const token = normalizeToken(authored, mode);
        const previous = seenForms.get(token);
        if (!token || previous) {
          throw new Error(`verification_status_vocabulary_invalid:${name}.duplicate_form:${authored}:${previous || "empty"}`);
        }
        seenForms.set(token, canonical);
        return authored;
      });
      if (!forms.some((form) => normalizeToken(form, mode) === canonicalKey)) {
        throw new Error(`verification_status_vocabulary_invalid:${name}.canonical_missing_from_forms:${canonical}`);
      }

      return Object.freeze({ canonical, kind, satisfies: status.satisfies, forms: Object.freeze(forms) });
    });

    contexts[name] = Object.freeze({ normalization: mode, statuses: Object.freeze(statuses) });
  }

  for (const required of ["presentation", "evidence", "program", "execution", "gate", "decision"]) {
    if (!contexts[required]) {
      throw new Error(`verification_status_vocabulary_invalid:missing_context:${required}`);
    }
  }
  return Object.freeze({ schema_version: 1, source_path: sourcePath, contexts: Object.freeze(contexts) });
}

export function loadVerificationStatusVocabulary({ path = DEFAULT_VOCABULARY_PATH } = {}) {
  if (path !== DEFAULT_VOCABULARY_PATH) {
    throw new Error(`verification_status_vocabulary_external_path_unsupported:${path}`);
  }
  return validateVocabulary(verificationStatusVocabularySource, path);
}

export function getVerificationStatusVocabulary() {
  if (!cachedVocabulary) cachedVocabulary = loadVerificationStatusVocabulary();
  return cachedVocabulary;
}

export function normalizeVerificationStatus(value, contextName) {
  const vocabulary = getVerificationStatusVocabulary();
  const context = vocabulary.contexts[contextName];
  if (!context) throw new Error(`verification_status_context_unknown:${contextName}`);
  const token = normalizeToken(value, context.normalization);
  if (!token) return { token: "", canonical: null, kind: "missing", satisfies: false, valid: false };
  for (const status of context.statuses) {
    if (status.forms.some((form) => normalizeToken(form, context.normalization) === token)) {
      return {
        token,
        canonical: status.canonical,
        kind: status.kind,
        satisfies: status.satisfies,
        valid: true,
      };
    }
  }
  return { token, canonical: null, kind: "unknown", satisfies: false, valid: false };
}

export function verificationStatusAcceptedForms(contextName) {
  const context = getVerificationStatusVocabulary().contexts[contextName];
  if (!context) throw new Error(`verification_status_context_unknown:${contextName}`);
  return context.statuses.flatMap((status) => status.forms);
}

export function verificationStatusSatisfies(value, contextName, { requireKind = null } = {}) {
  const normalized = normalizeVerificationStatus(value, contextName);
  return normalized.valid
    && normalized.satisfies
    && (requireKind === null || normalized.kind === requireKind);
}

export function verificationStatusIsPass(value, contextName) {
  return verificationStatusSatisfies(value, contextName, { requireKind: "pass" });
}

export function verificationStatusIsHardFailure(value, contextName) {
  const normalized = normalizeVerificationStatus(value, contextName);
  return !normalized.valid || normalized.kind === "fail";
}

export function deriveAntiRecurrencePresentationStatus(sectionContent) {
  const section = String(sectionContent || "");
  const tableLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const splitRow = (line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const header = tableLines.length >= 2 ? splitRow(tableLines[0]) : [];
  const rows = tableLines.slice(2).map(splitRow).filter((row) => row.some(Boolean));
  const normalizedHeader = header.map(identifierToken);
  const statusColumn = normalizedHeader.findIndex((cell) => cell.includes("status") || cell.includes("result"));
  const guardColumn = normalizedHeader.findIndex((cell) => cell.includes("guard_type") || cell === "guard");
  const guardValues = [];
  if (statusColumn !== -1 && guardColumn !== -1) {
    for (const row of rows) {
      if (verificationStatusIsPass(row[statusColumn], "presentation")) guardValues.push(row[guardColumn]);
    }
  }

  const labeledStatus = section.match(/^\s*[-*]?\s*status\s*:\s*([^\n]+)$/im);
  const labeledGuard = section.match(/^\s*[-*]?\s*guard types?\s*:\s*([^\n]+)$/im);
  if (verificationStatusIsPass(labeledStatus?.[1], "presentation")) guardValues.push(labeledGuard?.[1]);

  const inline = section.match(/^\s*([-A-Za-z/ ]+)\s+-\s+guard types?\s*:\s*([^\n]+)$/im);
  if (verificationStatusIsPass(inline?.[1], "presentation")) guardValues.push(inline?.[2]);
  return { passRecorded: guardValues.length > 0, guardValues };
}

export function verificationStatusBlocks(value, contextName, { requireKind = null } = {}) {
  return !verificationStatusSatisfies(value, contextName, { requireKind });
}

export function canonicalVerificationStatus(value, contextName, { fallback = null } = {}) {
  const normalized = normalizeVerificationStatus(value, contextName);
  return normalized.valid ? normalized.canonical : fallback;
}

function prologAtom(value) {
  return `'${String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function compileVerificationStatusFacts() {
  const vocabulary = getVerificationStatusVocabulary();
  const facts = [];
  for (const [contextName, context] of Object.entries(vocabulary.contexts)) {
    for (const status of context.statuses) {
      for (const form of status.forms) {
        facts.push(
          `verification_status_token(${prologAtom(contextName)}, ${prologAtom(normalizeToken(form, context.normalization))}, ${prologAtom(status.canonical)}, ${prologAtom(status.kind)}, ${status.satisfies ? "true" : "false"}).`,
        );
      }
    }
  }
  return `${facts.join("\n")}\n`;
}
