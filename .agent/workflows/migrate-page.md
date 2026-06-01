---
description: Migrate a WordPress page from Divi to clean HTML using the 6-stage safety pipeline
---

# /migrate-page Workflow

Migrate a single WordPress page from Divi builder to clean, maintainable HTML with CSS isolation.
Uses the PageMigrator 6-stage safety pipeline: BACKUP → SCRAPE → TRANSFORM → STAGE → PUBLISH → ROLLBACK.

**Human-in-the-loop**: Stage 5 (PUBLISH) always requires explicit human approval.

// turbo-all

## Prerequisites

- WordPress REST API credentials configured in `.env`
- `page_id` of the target page (find via WP admin or sitemap audit)
- Optional: new HTML content ready, or use CMO advisory output

## Stage 1: EXTRACT — Scrape and analyse the current page

```
Use MCP skill: page_migration.extract_page
  page_id: <PAGE_ID>
```

Review the extraction report:
- Number of sections, images, and text blocks
- Content structure and layout
- Any assets that need to be preserved

## Stage 2: DOWNLOAD ASSETS — Save images locally

```
Use MCP skill: page_migration.download_assets
  page_id: <PAGE_ID>
```

This creates `data/wp_assets/<PAGE_ID>/manifest.json` with all image mappings.
Verify that critical images are downloaded and accessible.

## Stage 3: GENERATE — Create new clean HTML

Options:
1. **Manual**: Write clean HTML in `data/wp_drafts/<PAGE_ID>.html`
2. **CMO-guided**: Run `/cmo-advisor` on the page URL to get improvement recommendations, then generate HTML based on those findings
3. **Template-based**: Use the extraction report sections as a scaffold

> **IMPORTANT**: The new HTML should NOT include Divi shortcodes or `et_pb_*` classes.
> Use semantic HTML5 elements (`<section>`, `<article>`, `<header>`, `<nav>`).
> Use the `.tess-btn` class for CTAs to get the styled button from the CSS isolation framework.

## Stage 4: BACKUP + STAGE — Push to draft with CSS isolation

```
Use MCP skill: page_migration.stage_as_draft
  page_id: <PAGE_ID>
  new_html: <CLEAN_HTML_CONTENT>
```

This automatically:
1. Creates a local backup at `data/wp_backups/page_<ID>_<TIMESTAMP>.json`
2. Wraps the HTML in `.tess-modern-content` CSS isolation
3. Injects the scoped stylesheet
4. Pushes to WordPress as a **DRAFT** (not published)

## Stage 5: REVIEW — Human-in-the-loop verification

⚠️ **MANUAL STEP — Do NOT automate this.**

1. Open the WordPress admin: `https://tesseract.academy/wp-admin/`
2. Navigate to Pages → find the draft
3. Click "Preview" to see how the page looks with the CSS isolation
4. Check:
   - [ ] Text is readable and properly formatted
   - [ ] Images are displaying correctly
   - [ ] CTAs (buttons, links) are functional
   - [ ] Mobile responsiveness (use browser dev tools)
   - [ ] No Divi CSS bleeding through (check h1-h6, paragraphs, links)
   - [ ] Page loads within 3 seconds

## Stage 6: PUBLISH or ROLLBACK

### If review passes:
```
Use MCP skill: page_migration.publish_staged
  page_id: <PAGE_ID>
```

### If review fails — ROLLBACK:
```
# First find the backup
Use MCP skill: page_migration.list_backups
  page_id: <PAGE_ID>

# Then rollback using the backup path
Use MCP skill: page_migration.rollback
  page_id: <PAGE_ID>
  backup_path: <PATH_FROM_LIST_BACKUPS>
```

## Post-Migration Checklist

After successful publication:
- [ ] Run a Clarity health check on the new page (`/clarity-stats`)
- [ ] Run `/cmo-advisor` to verify the health score improved
- [ ] Update the content registry if one exists
- [ ] Monitor for 24 hours — rollback immediately if issues are reported
- [ ] Archive the backup (keep for 30 days minimum)

## Quick Reference

| Scenario | Action |
|----------|--------|
| Page looks broken after staging | Check CSS isolation — is `.tess-modern-content` wrapper present? |
| Divi styles bleeding through | Increase specificity in `css_isolation.py` or add targeted overrides |
| Images broken after migration | Check `wp_assets/manifest.json` — are URLs absolute? |
| Need to migrate multiple pages | Run this workflow sequentially, one page at a time |
| Page uses Divi shortcodes in content | Extract text first, rebuild without shortcodes |
