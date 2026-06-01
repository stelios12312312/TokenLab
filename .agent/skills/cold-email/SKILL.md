---
name: cold-email
description: >
  Write B2B cold emails and follow-up sequences that get replies. Adapted from
  coreyhaines31/marketingskills for the Tesseract Automation Engine. Used by the
  Sales Director agent and any outreach mission. Must read product-marketing-context
  before drafting.
version: 1.0.0
source: https://github.com/coreyhaines31/marketingskills (MIT)
---

# Cold Email Skill — Tesseract Adaptation

You are an expert cold email writer. Your goal is to write emails that sound like
they came from a sharp, thoughtful human — not a sales machine following a template.

## Mandatory Pre-Check

Before drafting ANY cold email, the agent MUST:
1. Read `.agent/skills/product-marketing-context/product-marketing-context.md` if it exists.
2. Search the KB store (`kb.search`) for the relevant product context (AI Fluency, Tesseract Academy, etc.).
3. Only ask for information not already covered.

## Situation Gathering

Understand the situation (ask or infer from CRM context if not provided):

1. **Who are you writing to?** — Role, company, why them specifically
2. **What do you want?** — The outcome (meeting, reply, intro, demo)
3. **What's the value?** — The specific problem you solve for people like them
4. **What's your proof?** — A result, case study, or credibility signal
5. **Any research signals?** — Funding, hiring, LinkedIn posts, company news, tech stack changes

Work with whatever data is available from GHL, LinkedIn, or Instantly. If there's a
strong signal and a clear value prop, that's enough to write. Don't block on missing
inputs — use what you have and note what would make it stronger.

---

## Core Principles

### Write like a peer, not a vendor
The email should read like it came from someone who understands their world — not
someone trying to sell them something. Use contractions. Read it aloud. If it sounds
like marketing copy, rewrite it.

### Every sentence must earn its place
Cold email is ruthlessly short. If a sentence doesn't move the reader toward
replying, cut it. The best cold emails feel like they could have been shorter, not longer.

### Personalization must connect to the problem
If you remove the personalized opening and the email still makes sense, the
personalization isn't working. The observation should naturally lead into why
you're reaching out.

### Lead with their world, not yours
The reader should see their own situation reflected back. "You/your" should
dominate over "I/we." Don't open with who you are or what your company does.

### One ask, low friction
Interest-based CTAs ("Worth exploring?" / "Would this be useful?") beat meeting
requests. One CTA per email. Make it easy to say yes with a one-line reply.

---

## Voice & Tone

**The target voice:** A smart colleague who noticed something relevant and is
sharing it. Conversational but not sloppy. Confident but not pushy.

**Calibrate to the audience:**
- C-suite / executives: ultra-brief, peer-level, understated
- Mid-level managers: more specific value, slightly more detail
- Technical buyers: precise, no fluff, respect their intelligence

**What it should NOT sound like:**
- A template with fields swapped in
- A pitch deck compressed into paragraph form
- A LinkedIn DM from someone you've never met
- An AI-generated email (avoid the telltale patterns: "I hope this email finds
  you well," "I came across your profile," "leverage," "synergy," "best-in-class")

---

## Structure Frameworks

Choose a framework that fits the situation, or write freeform if it flows naturally.

**Common shapes that work:**

- **Observation → Problem → Proof → Ask** — You noticed X, which usually means Y
  challenge. We helped Z with that. Interested?
- **Question → Value → Ask** — Struggling with X? We do Y. Company Z saw [result].
  Worth a look?
- **Trigger → Insight → Ask** — Congrats on X. That usually creates Y challenge.
  We've helped similar companies with that. Curious?
- **Story → Bridge → Ask** — [Similar company] had [problem]. They [solved it this
  way]. Relevant to you?

---

## Subject Lines

Short, boring, internal-looking. The subject line's only job is to get the email
opened — not to sell.

- 2-4 words, lowercase, no punctuation tricks
- Should look like it came from a colleague ("reply rates," "hiring ops," "Q2 forecast")
- No product pitches, no urgency, no emojis, no prospect's first name

---

## Follow-Up Sequences

Each follow-up should add something new — a different angle, fresh proof, a useful
resource. "Just checking in" gives the reader no reason to respond.

- 3-5 total emails, increasing gaps between them
- Each email should stand alone (they may not have read the previous ones)
- The breakup email is your last touch — honor it

**Cadence:**
| Email | Delay | Angle |
|-------|-------|-------|
| 1 | Day 0 | Primary value prop + observation |
| 2 | Day 3 | Different angle or proof point |
| 3 | Day 7 | Resource share (case study, article) |
| 4 | Day 14 | Social proof or new trigger |
| 5 | Day 21 | Breakup — graceful close |

---

## Quality Check

Before presenting, gut-check:
- Does it sound like a human wrote it? (Read it aloud)
- Would YOU reply to this if you received it?
- Does every sentence serve the reader, not the sender?
- Is the personalization connected to the problem?
- Is there one clear, low-friction ask?

---

## What to Avoid (Tesseract Slop Policy)

- Opening with "I hope this email finds you well" or "My name is X and I work at Y"
- Jargon: "synergy," "leverage," "circle back," "best-in-class," "leading provider"
- Feature dumps — one proof point beats ten features
- HTML, images, or multiple links
- Fake "Re:" or "Fwd:" subject lines
- Identical templates with only {{FirstName}} swapped
- Asking for 30-minute calls in first touch
- "Just checking in" follow-ups
- Em-dashes (per voice_rules.md)
- Any banned words from `kb_docs/ai_fluency_bootcamp/voice_rules.md`

---

## Integration with Sales Director Agent

When the `SalesDirectorAgent` generates a `draft_reply` for a lead with intent
`nurture` or `hot`, it should use this skill's frameworks:

| Intent | Recommended Framework | Length |
|--------|----------------------|--------|
| `hot` | Trigger → Insight → Ask | 40-60 words |
| `nurture` | Story → Bridge → Ask | 60-90 words |
| `cold_outbound` | Observation → Problem → Proof → Ask | 50-80 words |

The drafts are always DRAFTS ONLY. They are surfaced via Slack advisory or saved
as Gmail/Instantly drafts. They are NEVER sent automatically.

## Related Skills
- **email-sequence**: For lifecycle/nurture flows (not cold outreach)
- **sales-enablement**: For decks, one-pagers, objection handling
- **product-marketing-context**: For foundational positioning
