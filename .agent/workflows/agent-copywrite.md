# Agent Copywrite Workflow

Invoke the Landing Page Copywriter skill to audit, diagnose, and rewrite landing page copy.

## When to Use

- When reviewing or rewriting an existing landing page, funnel, or email opt-in page.
- When generating copy for a new landing page.
- When performing a Conversion Rate Optimization (CRO) audit.

## Instructions for the Agent

When the user types `/agent-copywrite [target_page]`:

1. **Load the Skill:** You MUST immediately read the `.agent/skills/landing-page-copywriter/SKILL.md` file. This contains the strict rules and output formatting for your analysis.
2. **Load the Context:** You MUST read `.agent/skills/product-marketing-context/product-marketing-context.md` to understand Tesseract's brand and voice rules.
3. **Analyze the Target:** Read the HTML or Markdown file of the target page provided by the user. If they provide analytics (like Clarity or Google Analytics), read those as well.
4. **Output the Diagnosis:** Follow the strict output format required by the `landing-page-copywriter` skill. This means you MUST output:
    - **Conversion Diagnosis** (Audience, Awareness Level, Primary Problem, Recommended Strategy)
    - **Hero Variants** (At least 3 variants, one using the "Achieve X Without Y" formula)
    - **Recommended Hero**
    - **Landing Page Copy** (Section by section, if the user requested a full rewrite, otherwise a prioritized CRO audit)
    - **CTA Variants** (At least 5 variants)
    - **Proof Recommendations**
    - **Quality Check** (1-5 rating on clarity, scannability, outcome focus, etc.)

**Important:** Do NOT skip the Quality Check. If any score in the Quality Check is below a 4, revise your copy before showing it to the user.
