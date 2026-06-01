---
description: How to manage cPanel email accounts, forwarders, and Instantly integration for Tesseract sending infrastructure
---

# cPanel API — Reference Skill

> **Infrastructure scope**: Bluehost/cPanel is used for **email infrastructure** (Instantly sending accounts, forwarders) and **other websites** (skampakis.com, thedatascientist.com, etc.). The **tesseract.academy** WordPress site is hosted on **Cloudways**, NOT Bluehost.

## Authentication
- cPanel API Token via `CPANEL_TOKEN` env var
- Host: `CPANEL_HOST` env var (`skampakis.com` — Bluehost, cPanel user: `skampaki`)
- Username: `CPANEL_USERNAME` env var
- Auth header: `Authorization: cpanel <username>:<token>`
- Base URL: `https://<host>:2083/execute`

## Quick Reference: Endpoints

| Action | UAPI Module | Key Params |
|---|---|---|
| List email accounts | `Email::list_pops` | — |
| Create email account | `Email::add_pop` | `email`, `password`, `domain`, `quota` |
| List forwarders | `Email::list_forwarders` | `domain` |
| Add forwarder | `Email::add_forwarder` | `email`, `domain`, `fwdopt=fwd`, `fwdemail` |

## Connector Methods

```python
from tesseract_operator.connectors.cpanel import CpanelConnector

cpanel = CpanelConnector(
    host=os.environ["CPANEL_HOST"],
    username=os.environ["CPANEL_USERNAME"],
    token=os.environ["CPANEL_TOKEN"],
    dry_run=False,
)

# List all email accounts
accounts = cpanel.list_emails()

# Create a new email account
cpanel.create_email(email="sales1", password="...", domain="example.com", quota=500)

# List forwarders for a domain
fwds = cpanel.list_forwarders(domain="example.com")

# Add a forwarder
cpanel.add_forwarder(email="sales1", domain="example.com", forward_to="inbox@gmail.com")
```

## Scripts

### Provision Emails
Create email accounts on cPanel and add them to Instantly for warmup:
```bash
python scripts/provision_emails.py \
  --domain tesseract-academy.tech \
  --prefix sales \
  --count 3 \
  --password "SuperSecret123!"
```

### Setup Forwarders
Forward replies from all Instantly sending accounts to a central Gmail inbox:
```bash
# Dry run first
python scripts/setup_forwarders.py --forward-to stelios@thetesseractacademy.com --dry-run

# Live run
python scripts/setup_forwarders.py --forward-to stelios@thetesseractacademy.com
```

This scans all active Instantly campaigns, identifies sending accounts, and creates
cPanel forwarders on each one. Skips accounts that already have forwarders.

## Current Infrastructure

**10 domains** on Bluehost cPanel with **26 sending accounts** in the active Greek CEOs campaign:

| Domain | Accounts |
|--------|----------|
| academytesseract.com | 1 |
| globaltesseract.co | 1 |
| tesseract-academy-ai-web3.com | 2 |
| tesseract-academy-ai-web3.net | 2 |
| tesseract-academy-ai-web3.org | 5 |
| tesseract-academy.com | 2 |
| tesseract-academy.tech | 1 |
| tesseractacademy.org | 5 |
| tesseractacademy.tech | 3 |
| the-tes-academy.com | 4 |

All 26 accounts forward to `stelios@thetesseractacademy.com`.

## Naming Conventions (MANDATORY)
1. **Personal over Generic**: NEVER use generic prefixes (`sales`, `info`, `outreach`) for outreach accounts unless explicitly requested. Stylianos (Stelios) Kampakis's personal brand is central to the project.
2. **Preferred Patterns**:
   - `stelios@domain`
   - `stylianos@domain`
   - `s.kampakis@domain`
   - `stelios.kampakis@domain`
   - `stylianos.kampakis@domain`
3. **Confirmation**: Always confirm the specific mailbox name with the user before creation if it's not a common pattern or previously used for that domain.

## Known Gotchas
1. **OPERATOR_DRY_RUN**: The global `OPERATOR_DRY_RUN=1` in `.env` affects `OperatorConfig`. Scripts that need live API access should use `dotenv` directly instead of `OperatorConfig`.
2. **cPanel UAPI uses query params**: Even for POST endpoints, pass data as `params={}` not `json_body={}`.
3. **Forwarder param name**: The destination email param is `fwdemail`, not `forward_to`.
4. **Generic Prefix Trap**: Avoid generic `salesN` naming (M-2026-05-05-01).
