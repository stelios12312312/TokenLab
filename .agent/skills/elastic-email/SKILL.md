---
name: elastic-email-api
description: How to use the Elastic Email integration for fetching engagement data, bounces, and unsubscribes
---

# Elastic Email API Skill

## Purpose
This skill exposes the Elastic Email internal connector, enabling agents to fetch email delivery analytics and lists of unengaged or bounced contacts. Elastic Email is used as the email sending platform (ESP) for Tesseract's bulk campaigns (e.g. through GoHighLevel), and direct querying is often required when GHL abstracts or hides the underlying email bounce metrics.

## Component Overview

The Elastic Email stack consists of:
- **Connector**: `tesseract_operator/connectors/elastic.py` -> `ElasticEmailConnector`
- **Skills module**: `tesseract_operator/skills/elastic_skills.py`
- **Config**: Relies on `ELASTIC_EMAIL_API_KEY` in `.env` (maps to `OperatorConfig.elastic_email_api_key`)

## Available Actions

### 1. `elastic.contact.get`
Fetches a single contact's engagement profile directly from Elastic Email to verify deliverability status (Active, Bounced, Unsubscribed, etc).
- **Args**: `email` (str)
- **Returns**: A JSON dictionary mapping to the Elastic Email Contact response scheme.

### 2. `elastic.contacts.load_bounced`
Fetches all bounces from the Elastic Email API up to the `max_fetch` parameter using cursor pagination.
- **Args**: `max_fetch` (int, default: 50,000)
- **Returns**: A list of contact dictionaries where Status is "Bounced".

### 3. `elastic.contacts.load_unsubscribed`
Fetches all unsubscribed contacts. 
- **Args**: `max_fetch` (int, default: 50,000)
- **Returns**: A list of contact dictionaries where Status is "Unsubscribed".

## Gotchas & API Details
- **API Versioning**: The base connector points to the Elastic Email `v4` API by default (`https://api.elasticemail.com/v4/`).
- **Authentication**: Auth is configured using the `X-ElasticEmail-ApiKey` header. The connector manages this automatically.
- **Endpoints**: GHL list-level bounce tracking is often opaque; these Elastic Email skills are the definitive ground truth for deliverability status.
- **Data Parity with CRM**: Merging Elastic Email bounces with GHL endpoints is a standard pattern for contact hygiene. Refer to `.agent/workflows/ghl-email-cleanup.md` and `scripts/ghl_email_cleanup.py` for an example of cross-platform sanitization logic.
