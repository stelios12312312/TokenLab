---
description: Fetch live insights from Microsoft Clarity and generate improvement recommendations
---
<!-- planner:host-owned-workflow -->
# /clarity-stats Workflow

This workflow fetches recent website analytics from Microsoft Clarity via the Data Export API, and analyzes the traffic across different dimensions (e.g., browser, device, source) to provide actionable improvements for the landing pages.

## Prerequisites

- You must have `CLARITY_API_KEY` set in your `.env` file.
- The `clarity.get_live_insights` skill must be available in the MCP server.

// turbo

## Step 1: Fetch Live Insights

1. **Invoke the `clarity.get_live_insights` skill** with `num_of_days=3` and relevant `dimensions` (e.g., array of `['device', 'source', 'browser']`).
   - If the task requires different dimensions, modify the arguments accordingly.
   
## Step 2: Analyze Data

1. **Review the returned JSON** containing the live insights.
2. Identify:
   - What the top traffic sources are.
   - Any devices or browsers with unusual stats that could hint at UX issues.
   - Any traffic segments that are underrepresented.

## Step 3: Recommend Improvements

1. **Generate a Markdown summary** of the findings.
2. Provide concrete recommendations on how to improve the pages and user experience (e.g., fixing mobile responsiveness, optimizing for specific browsers, or doubling down on top-performing traffic sources).
