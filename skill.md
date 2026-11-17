# IssueReady — skill for MCP clients

Use this file with any MCP-compatible agent (Claude Code, Cursor, VS Code).
It describes the IssueReady MCP server: a Jira data-quality auditor that scores
issues 0–100 with deterministic, explainable rules — no LLM, no guessing.

## Connect

Remote MCP server (after the app is installed on your Atlassian site and the
site admin enables external tools in Admin > Apps > Sites > <site> >
Connected apps > IssueReady > Tools):

```
https://mcp.atlassian.com/forge/<appId>
```

`<appId>` is the UUID in `app.id` of `manifest.yml` (the part after
`ari:cloud:ecosystem::app/`). Example with Claude Code:

```
claude mcp add --transport http issue-ready https://mcp.atlassian.com/forge/<appId>
```

## Tools

| Tool | What it does | When to use it |
|---|---|---|
| `audit-issue` | Score ONE issue 0–100 + every failed check | "Is DEMO-3 ready for triage?" |
| `list-data-debt` | Worst-scoring open issues, worst first | "What is blocking triage?" |
| `project-quality-summary` | Project average, grades, verdicts, top problems, duplicates | "How healthy is this project's Jira data?" |
| `suggest-fixes` | Safe one-click fixes for one issue (read-only) | "How do I fix DEMO-3?" |
| `apply-fixes` | Applies the safe fixes (priority, label normalisation) | Only after the user confirms |
| `bulk-apply-fixes` | Applies the safe fixes to EVERY fixable issue in a project; reports fixed + skipped counts | Only after the user confirms |

## More

- Every project audit is snapshotted (date, average, verdict counts); the
  project page shows the trend, and a scheduled audit re-runs every Monday.
- The project page can export the current audit as a CSV file.

## Rules for the agent

- Quote only numbers the tools return. Never invent a score.
- A score below 50 is BLOCKED, 50–69 NEEDS_WORK, 70+ READY (and no critical findings).
- Dimensions: completeness 30, ownership 20, planning 15, labels 15, freshness 10, linkage 10.
- Duplicates are found by word-level Jaccard similarity on title and on
  summary + description (higher of the two; >= 0.7 = likely duplicate,
  0.5–0.7 = similar, not a duplicate).
- Always confirm with the user before calling `apply-fixes` or
  `bulk-apply-fixes`.
