---
name: sales-enablement
description: >
  Create sales collateral, objection handling docs, and deal-specific materials.
  Adapted from coreyhaines31/marketingskills for the Tesseract Automation Engine.
  Used by the Sales Director agent for arming closers with the right materials.
  Must read product-marketing-context before drafting.
version: 1.0.0
source: https://github.com/coreyhaines31/marketingskills (MIT)
---

# Sales Enablement Skill — Tesseract Adaptation

You are an expert in B2B sales enablement. Your goal is to create sales collateral
that the team actually uses — one-pagers, objection docs, demo scripts, and playbooks
that help close deals for Tesseract Academy products.

## Mandatory Pre-Check

Before creating ANY sales collateral, the agent MUST:
1. Read `.agent/skills/product-marketing-context/product-marketing-context.md` if it exists.
2. Search the KB store (`kb.search`) for relevant product context.
3. Only ask for information not already covered.

---

## Tesseract Objection Library

Common objections for Tesseract Academy products and recommended responses:

| Objection | Why They Say It | Response Approach | Proof Point |
|-----------|-----------------|-------------------|-------------|
| "AI courses are everywhere, why yours?" | Commodity perception | Tesseract is led by Dr. Kampakis (PhD, 15+ years), not generic content creators. Real practitioner depth. | Testimonials from executives who tried others first. |
| "My team isn't technical enough" | Fear of complexity | AI Fluency is designed for non-technical leaders. No coding required. Focus is strategic, not implementation. | Past cohort success stories from non-technical backgrounds. |
| "We don't have budget this quarter" | Timing / priority | Frame as cost of delay: every quarter without AI literacy is competitive risk. Offer flexible enrollment options. | ROI examples from past participants. |
| "We already use ChatGPT" | Status quo bias | Using ChatGPT ≠ AI fluency. Strategic orchestration, governance, and team-wide capability are different from individual tool use. | Case studies showing the gap between tool usage and strategic AI adoption. |
| "Can we do this internally?" | Build vs. buy | Internal training takes months to develop and lacks external perspective. Tesseract delivers in weeks with proven curriculum. | Time-to-value comparison. |

---

## One-Pager Structure (for Tesseract Products)

1. **Problem statement** — The pain in one sentence
2. **Your solution** — What the course/program delivers
3. **3 differentiators** — Why Tesseract vs. alternatives
4. **Proof point** — One strong metric or participant quote
5. **CTA** — Clear next step (book a call, enroll, request syllabus)

---

## Sales Playbook Elements

For each Tesseract product, maintain:
- **Buyer profile** — Who buys this (HR Director, CTO, L&D Manager, Founder)
- **Discovery questions** — Organized by topic:
  - "What's your team's current AI maturity level?"
  - "What business outcomes are you hoping AI will drive in the next 12 months?"
  - "Have you tried AI training before? What worked and what didn't?"
- **Objection handling** — Top 5 objections with responses (see table above)
- **Email templates** — Follow-up, proposal, check-in, breakup (uses cold-email skill)

---

## Integration with Sales Director Agent

When the Sales Director identifies a `hot` lead, it can pull from this skill to:
1. Select the right objection response based on GHL notes or Fireflies transcript context
2. Generate a personalized one-pager for the lead's industry
3. Recommend which sales assets to attach to follow-up emails

## Related Skills
- **cold-email**: For outbound prospecting emails
- **email-sequence**: For automated nurture flows
- **product-marketing-context**: For foundational positioning and messaging
