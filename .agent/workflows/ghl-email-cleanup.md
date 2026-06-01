---
description: How to clean up defunct and bounced email addresses in GoHighLevel using Elastic Email intelligence
---

# GHL Email Cleanup Workflow

This workflow is to be used when instructed to "clean up emails", "remove bad contacts", or "sync elastic email bounces to GHL".

## Context
GoHighLevel (GHL) manages the CRM contacts, but Elastic Email handles the actual delivery of bulk email marketing. When emails bounce or users unsubscribe, Elastic Email records this but GHL's API does not uniformly expose those specific metrics on bulk contact extraction. 

To solve this, we use the `scripts/ghl_email_cleanup.py` script, which:
1. Connects to the Elastic Email v4 API to fetch all `Bounced` and `Unsubscribed` limits.
2. Extracts up to N contacts via cursor pagination from GHL.
3. Evaluates every GHL contact against its native GHL tags (e.g. `invalid_email`) AND the external Elastic Email lists.
4. Generates a list of bad contacts, optionally executing cleanup tagging on them.

## Workflow Steps

### Step 1: Verification / Dry Run
Always run the script in `--max` and non-execute mode first to analyze the dataset.

// turbo-all
```bash
# Analyze a sample payload before blowing up API quotas
python scripts/ghl_email_cleanup.py --max 1000 --out bad_contacts_preview.csv
```

### Step 2: Review Output
Review the end logs output by the script. It will print validation counts:
- `Found X bad emails from Elastic Email API`
- `Analysis Complete. Found Y contacts to clean up...`

If `Y > 0`, offer to download the `.csv` or show the user the head of the file.

### Step 3: Execution mode
Once the user explicitly confirms cleanup, run the script globally passing `--execute`.

```bash
# Replace max with the desired amount of contacts, defaults to 20000
python scripts/ghl_email_cleanup.py --max 25000 --out bad_contacts_mar26.csv --execute
```

> **Note on Execution**: The `--execute` flag currently applies the tag `cleanup_mar2026` rather than a destructive deletion operation. This gives operators a safe window to create a Smart List in GHL and bulk-delete via the GHL UI if they don't want to risk automated irreversible record erasure. 

### Step 4: Inactive/Stale Contacts (Optional)

If you also want to flag contacts who haven't engaged in months (Elastic Email's `Inactive` and `Stale` statuses), add the `--include-inactive` flag:

```bash
python scripts/ghl_email_cleanup.py --include-inactive --max 1000 --out inactive_preview.csv
```

> **⚠️ Important**: Inactive and stale contacts are **softer signals** than bounces. Always review the CSV before acting on them — some contacts may simply be slow openers or seasonal responders. These are opt-in for a reason.
