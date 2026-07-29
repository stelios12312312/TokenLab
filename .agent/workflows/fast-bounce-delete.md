---
description: How to instantly purge hard-bounced contacts from GoHighLevel by reverse-querying Elastic Email in bulk
---
<!-- planner:host-owned-workflow -->

# Fast Bounce Deletion Workflow

This workflow is to be used when instructed to "delete hard bounces", "purge dead emails", or "remove invalid contacts from GHL".

## Context
When trying to clean up thousands of GoHighLevel (GHL) contacts against Elastic Email, pinging the Elastic Email API for every single user (`get_contact(email)`) will quickly trigger a 429 Too Many Requests rate-limit throttle.

To bypass this and achieve instant sanitization, we use the **Reverse Query** methodology:
1. Make a bulk `GET` request to Elastic Email to download a master set of ALL emails marked as `Bounced`, `Invalid`, `Abuse`, or `SpamComplaint`.
2. Pull the targeted contacts from GoHighLevel.
3. Locally cross-reference the GoHighLevel emails against the Elastic Email "bad set" in memory.
4. Execute `delete_contact` on GoHighLevel strictly for the matching records.

This process handles 10,000+ contacts in seconds without hitting rate limits.

## The Recipe Script
The script for this exact operation is located at: `scripts/delete_bounced_fast.py`

## Workflow Steps

### Step 1: Verification
Always ensure you understand which GHL segment you are targeting. By default, `delete_bounced_fast.py` targets the `cold_dormant` tag. If you need to target a different segment (or the entire database), you must modify `TARGET_TAG` in the script before running.

### Step 2: Execution
Run the script to execute the bulk cross-reference and irreversible deletion.

// turbo
```bash
python scripts/delete_bounced_fast.py
```

### Step 3: Reporting
The script will output exact counts:
- The total number of bad emails pulled from Elastic Email.
- The total matches found in GoHighLevel.
- The number of successful deletions.

Report these exact metrics back to the user to close the task.
