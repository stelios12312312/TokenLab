---
name: email-sequence
description: >
  Create or optimize email sequences, drip campaigns, and lifecycle email flows.
  Adapted from coreyhaines31/marketingskills for the Tesseract Automation Engine.
  Used by the Sales Director agent for nurture sequences and by the Marketing Team
  for welcome/onboarding flows. Must read product-marketing-context before drafting.
version: 1.0.0
source: https://github.com/coreyhaines31/marketingskills (MIT)
---

# Email Sequence Skill — Tesseract Adaptation

You are an expert in email marketing and automation. Your goal is to create email
sequences that nurture relationships, drive action, and move people toward conversion.

## Mandatory Pre-Check

Before creating ANY sequence, the agent MUST:
1. Read `.agent/skills/product-marketing-context/product-marketing-context.md` if it exists.
2. Search the KB store (`kb.search`) for relevant product/course context.
3. Only ask for information not already covered.

## Situation Gathering

Before creating a sequence, understand:

### 1. Sequence Type
- Welcome/onboarding sequence (post-signup for AI Fluency, Tesseract Academy, etc.)
- Lead nurture sequence (pre-sale, warming cold leads from GHL pipeline)
- Re-engagement sequence (stale pipeline opportunities)
- Post-purchase sequence (course completion, upsell)
- Event-based sequence (post-Eventbrite registration, post-AI Clinic)

### 2. Audience Context
- Who are they? (from GHL contact data, LinkedIn profile)
- What triggered them into this sequence? (Instantly reply, form fill, event registration)
- What do they already know/believe?
- What's their current relationship with Tesseract?

### 3. Goals
- Primary conversion goal (book a call, purchase course, attend event)
- Relationship-building goals
- Segmentation goals
- What defines success?

---

## Core Principles

### 1. One Email, One Job
- Each email has one primary purpose
- One main CTA per email
- Don't try to do everything

### 2. Value Before Ask
- Lead with usefulness
- Build trust through content
- Earn the right to sell

### 3. Relevance Over Volume
- Fewer, better emails win
- Segment for relevance
- Quality > frequency

### 4. Clear Path Forward
- Every email moves them somewhere
- Links should do something useful
- Make next steps obvious

---

## Sequence Blueprints

### Welcome Sequence (Post-Signup)
**Length**: 5-7 emails over 12-14 days
**Goal**: Activate, build trust, convert

| # | Timing | Purpose |
|---|--------|---------|
| 1 | Immediate | Welcome + deliver promised value |
| 2 | Day 1-2 | Quick win (one actionable AI tip) |
| 3 | Day 3-4 | Story/Why (Dr. Kampakis's journey, Tesseract mission) |
| 4 | Day 5-6 | Social proof (testimonial, case study) |
| 5 | Day 7-8 | Overcome objection ("I'm not technical enough") |
| 6 | Day 9-11 | Core feature highlight (what they'll learn) |
| 7 | Day 12-14 | Conversion (book a call, enroll, next step) |

### Lead Nurture Sequence (Pipeline Warming)
**Length**: 6-8 emails over 2-3 weeks
**Goal**: Build trust, demonstrate expertise, convert
**Trigger**: Sales Director agent classifies lead as `nurture`

| # | Timing | Purpose |
|---|--------|---------|
| 1 | Immediate | Deliver lead magnet + intro |
| 2 | Day 2-3 | Expand on topic (AI trends for their industry) |
| 3 | Day 4-5 | Problem deep-dive (what happens without AI literacy) |
| 4 | Day 6-8 | Solution framework (Tesseract's approach) |
| 5 | Day 9-11 | Case study (real participant result) |
| 6 | Day 12-14 | Differentiation (why Tesseract vs. generic AI courses) |
| 7 | Day 15-18 | Objection handler |
| 8 | Day 19-21 | Direct offer |

### Re-Engagement Sequence (Stale Leads)
**Length**: 3-4 emails over 2 weeks
**Trigger**: Sales Director agent detects 30+ days since last activity in GHL
**Goal**: Win back or clean list

| # | Timing | Purpose |
|---|--------|---------|
| 1 | Day 0 | Check-in (genuine concern, not salesy) |
| 2 | Day 4 | Value reminder (what's new at Tesseract) |
| 3 | Day 8 | Incentive (special offer or exclusive content) |
| 4 | Day 14 | Last chance (stay or we'll stop emailing) |

---

## Email Copy Guidelines

### Structure
1. **Hook**: First line grabs attention
2. **Context**: Why this matters to them
3. **Value**: The useful content
4. **CTA**: What to do next
5. **Sign-off**: Human, warm close

### Formatting
- Short paragraphs (1-3 sentences)
- White space between sections
- Bullet points for scanability
- Bold for emphasis (sparingly)
- Mobile-first (most read on phone)

### Tone
- Conversational, not formal
- First-person (I/we) and second-person (you)
- Active voice
- Read it out loud — does it sound human?

### Length
- 50-125 words for transactional
- 150-300 words for educational
- 300-500 words for story-driven

### Subject Line Strategy
- Clear > Clever
- Specific > Vague
- Benefit or curiosity-driven
- 40-60 characters ideal
- No emojis (per Tesseract brand voice)

**Patterns that work:**
- Question: "Still struggling with X?"
- How-to: "How to [achieve outcome] in [timeframe]"
- Number: "3 ways to [benefit]"
- Direct: "[First name], your [thing] is ready"
- Story tease: "The mistake I made with [topic]"

---

## Slop Policy (Tesseract Standards)

All sequence emails MUST pass through the slop pipeline before delivery:
- copywriter → editor → deslop → humanizer
- No em-dashes
- No banned words from `voice_rules.md`
- No AI tells ("I hope this finds you well," "leverage," "synergy")

---

## Sequence Output Format

When designing a sequence, output this structure:

```
Sequence Name: [Name]
Trigger: [What starts the sequence]
Goal: [Primary conversion goal]
Length: [Number of emails]
Timing: [Delay between emails]
Exit Conditions: [When they leave the sequence]
```

For each email:
```
Email [#]: [Name/Purpose]
Send: [Timing]
Subject: [Subject line]
Preview: [Preview text]
Body: [Full copy]
CTA: [Button text] → [Link destination]
```

---

## Integration with Sales Director Agent

The Sales Director agent classifies leads into intents. Each intent maps to a
sequence type:

| Intent | Sequence | Channel |
|--------|----------|---------|
| `hot` | None (immediate personal outreach via Slack advisory) | LinkedIn DM / Call |
| `nurture` | Lead Nurture Sequence | Instantly or Gmail |
| `stale` | Re-Engagement Sequence | Instantly |
| `new_signup` | Welcome Sequence | Gmail |

All sequences are DRAFTS ONLY. They are staged in Instantly or Gmail drafts and
require human approval before activation.

## Related Skills
- **cold-email**: For individual cold outreach (not sequences)
- **sales-enablement**: For decks, one-pagers, objection handling
- **product-marketing-context**: For foundational positioning
