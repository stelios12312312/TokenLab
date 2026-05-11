# Rule: Always Produce HTML Report

## Context
When running TokenLab simulations (especially M1/M2 scenarios), the output consists of CSVs, JSON summaries, and static plots. An HTML report consolidates this into a readable format.

## Requirement
Whenever you execute a simulation run (e.g., using `run.py` or similar scripts), you MUST ensure that the script produces the combined HTML report at the end of the run.

If the user asks you to run a sweep or a scenario, do not just generate the data—ensure the HTML report is generated and provide the user with the absolute `file://` path to the `M2_report.html` (or equivalent HTML output) so they can view the results instantly.
