# Integration Gotchas
*Traps specific to integration, API, and multi-system work. Seed file for new project knowledge bases.*

## IG-001 | REST Authentication Fails Silently
**Project origin**: WordPress CQA
**Pattern**: REST API appears to work but returns stale/default data because auth token was rejected. No error visible to caller.
**Fix**: Always verify auth explicitly: check for auth-related headers in response, or test with an endpoint that requires auth.

## IG-002 | API Key Enforcement Changes Without Notice
**Project origin**: IPBS (balldontlie.io)
**Pattern**: Previously open API endpoints suddenly require auth. System silently fails with 401/403.
**Fix**: Multi-provider redundancy — if primary returns auth error, fall through to secondary source.

## IG-003 | SSL Certificate Delays Cascade
**Project origin**: IPBS (football-data.org)
**Pattern**: Certificate authority delays cause "Insecure Connection" errors. Entire data pipeline fails.
**Fix**: Catch SSL errors separately from data errors. Fall through to alternative provider.

## IG-004 | CDN Data Staleness
**Project origin**: IPBS (cdn.nba.com)
**Pattern**: CDN returns yesterday's data until rollover. Code requesting "today's" data gets stale results.
**Fix**: For backfilling, use API not CDN. For live, verify data timestamp matches expected date.

## IG-005 | ENV Config Drift Across Machines
**Project origin**: Tesseract Engine, IPBS
**Pattern**: 12+ env variables missing when moving between machines. No startup validation catches this.
**Fix**: Startup validation script that checks all required vars and reports missing/empty ones.

## IG-006 | Provider:Model Format Parsing
**Project origin**: WordPress CQA
**Pattern**: Config value like `openai:gpt-4` parsed inconsistently across classes — some split on `:`, some use full string as model name.
**Fix**: Single parsing function. Add parity registry entry for all classes that parse this format.
