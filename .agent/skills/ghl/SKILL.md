---
description: How to use GoHighLevel (GHL) CRM for contacts, opportunities, pipelines, funnels, voice AI, tasks, and social media management
---

# GoHighLevel (GHL) CRM — Reference Skill

## Authentication
- API Key via `GHL_API_KEY` env var
- Location ID via `GHL_LOCATION_ID` env var
- Connector: `tesseract_operator/connectors/ghl.py`
- Skills: `tesseract_operator/skills/ghl_skills.py`, `ghl_outreach_skills.py`

## Available Skills (37 total)

### Contacts
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.contacts.list` | LOW | ✅ | List/search contacts |
| `ghl.contacts.get` | LOW | ✅ | Get single contact |
| `ghl.contacts.create` | MEDIUM | ✅ | Create contact |
| `ghl.contacts.update` | MEDIUM | ✅ | Update contact fields |
| `ghl.contacts.delete` | HIGH | ❌ | Delete a contact — requires approval |
| `ghl.contacts.search` | LOW | ✅ | Search by name/email/phone |
| `ghl.journey.map` | LOW | ✅ | User journey assembled from GHL data |
| `ghl.journey.attributions` | LOW | ✅ | UTM/source attribution for a contact |

### Pipeline & Opportunities
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.pipelines.list` | LOW | ✅ | List pipelines |
| `ghl.pipeline.stages` | LOW | ✅ | List sales pipeline stages |
| `ghl.pipeline.move_stage` | MEDIUM | ✅ | Move opportunity to a named stage |
| `ghl.pipeline.draft_outreach` | LOW | ❌ | Draft personalized outreach emails |
| `ghl.opportunities.list` | LOW | ✅ | List opportunities |
| `ghl.opportunities.get` | LOW | ✅ | Get single opportunity |
| `ghl.opportunities.create` | MEDIUM | ✅ | Create opportunity |
| `ghl.opportunities.update` | MEDIUM | ✅ | Update opportunity |
| `ghl.opportunities.delete` | HIGH | ❌ | Delete opportunity — requires approval |

### Notes, Tasks, Tags
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.notes.list` | LOW | ✅ | List contact notes |
| `ghl.notes.create` | MEDIUM | ✅ | Create contact note |
| `ghl.tasks.list` | LOW | ✅ | List contact tasks |
| `ghl.tasks.create` | MEDIUM | ✅ | Create contact task |
| `ghl.tags.list` | LOW | ✅ | List all tags |
| `ghl.tags.add` | MEDIUM | ✅ | Add tags to contact |
| `ghl.tags.remove` | MEDIUM | ✅ | Remove tags from contact |
| `ghl.custom_fields.list` | LOW | ✅ | List custom fields |

### Funnels
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.funnels.list` | LOW | ✅ | List all funnels |
| `ghl.funnels.get` | LOW | ✅ | Get single funnel |
| `ghl.funnels.pages` | LOW | ✅ | List funnel pages |
| `ghl.funnels.stats` | LOW | ✅ | Get funnel stats |
| `ghl.funnels.optins` | LOW | ✅ | Count opt-ins by source |
| `ghl.funnel_notes.list` | LOW | ✅ | List funnel notes |
| `ghl.funnel_notes.get` | LOW | ✅ | Get single funnel note |
| `ghl.funnel_notes.create` | MEDIUM | ✅ | Create funnel note |
| `ghl.funnel_notes.update` | MEDIUM | ✅ | Update funnel note |
| `ghl.funnel_notes.delete` | HIGH | ❌ | Delete funnel note — requires approval |

### Voice, Social, Workflows, Users
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.voice.list` | LOW | ✅ | List voice agent calls |
| `ghl.voice.transcript` | LOW | ✅ | Get call transcript |
| `ghl.voice.trigger` | HIGH | ❌ | Trigger outbound call — requires approval |
| `ghl.social.accounts` | LOW | ✅ | List connected social accounts |
| `ghl.social.post` | MEDIUM | ✅ | Schedule social media post |
| `ghl.workflow.add_contact` | MEDIUM | ✅ | Add contact to automation workflow |
| `ghl.users.list` | LOW | ✅ | List GHL users |

## Pipeline Stages (auto-populated)
Configured in `.env` as `GHL_SALES_STAGE_*` variables. Use `ghl.pipeline.stages` to list.

### CRM Alignment (Big Cleanup)
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.crm.align` | HIGH | ❌ | Full pipeline cleanup: dedup + crossval + fix stages + fix notes |

**Script**: `scripts/ghl_crm_align.py`
**Workflow**: `.agent/workflows/crm-align.md`

Run when user says: "align CRM", "clean up pipeline", "fix GHL", "remove duplicates", "CRM alignment", "pipeline cleanup", or "fix stages/notes".

```bash
# Dry run (report only)
python scripts/ghl_crm_align.py

# Apply all fixes
python scripts/ghl_crm_align.py --fix

# Fast dedup only
python scripts/ghl_crm_align.py --fix --skip-crossval

# Export report
python scripts/ghl_crm_align.py --csv reports/crm_align.csv
```

Phases: SNAPSHOT → DEDUP → CROSSVAL → NOTES → STAGE-FIX → REPORT
Zero LLM tokens — fully deterministic rule-based classification.

### Cross-Validation & Diagnostics
| Skill | Risk | MCP | Description |
|-------|------|-----|-------------|
| `ghl.pipeline.crossval` | LOW | ✅ | Cross-validate pipeline against Gmail/Calendar/Fireflies/Instantly |
| `ghl.pipeline.deduplicate` | HIGH | ❌ | Remove duplicate opportunities (keeping most advanced stage) |

## Known Gotchas
1. Location-scoped API — all requests are scoped to `GHL_LOCATION_ID`
2. Rate limit: ~100 req/min. Add `time.sleep(0.3)` between batches
3. Contact search is partial-match — use `ghl.contacts.search` for fuzzy
4. Pipeline stage IDs are UUIDs stored in `.env` — use `ghl.pipeline.move_stage` with stage NAME not ID
