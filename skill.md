# IssueReady — skill for MCP clients

Use this file with any MCP-compatible agent (Claude Code, Cursor, VS Code).
It describes the IssueReady MCP server: a Jira data-quality auditor that scores
issues 0–100 with deterministic, explainable rules — no LLM, no guessing.

## Connect

Remote MCP server. The app is installed on the developer site
https://issue-ready.atlassian.net and its `rovo:mcp` module exposes the
tools below through Atlassian's MCP server:

```
https://mcp.atlassian.com/forge/2731571b-7f8a-4478-975e-945365298219
```

The UUID is the `app.id` in `manifest.yml` (the part after
`ari:cloud:ecosystem::app/`). It must match the deployed app id
`2731571b-7f8a-4478-975e-945365298219` — if it doesn't, the tools below
will not load.

Steps (Claude Code example; Cursor and VS Code are the same URL, see
`MCP-USAGE.md` in the repository root for all three):

1. Install IssueReady on your Atlassian site from the install link, and
   have the site admin enable external tools in Admin > Apps > Sites >
   `<site>` > Connected apps > IssueReady > Tools.
2. Add the server:
   ```
   claude mcp add --transport http issue-ready https://mcp.atlassian.com/forge/2731571b-7f8a-4478-975e-945365298219
   ```
3. When the client asks, sign in with your Atlassian account (OAuth).
   The server answers 401 until you do — that is expected, not a bug.
4. Ask e.g. "How healthy is this project's Jira data?" and the client
   should offer the `project-quality-summary` tool.

### Verification status (2026-11-17, honest)

- The 6 tool payloads were verified locally against the demo data with
  `node /tmp/mcp-harness.mjs`: `audit-issue` DEMO-3 = 85/A/NEEDS_WORK,
  `suggest-fixes` DEMO-5 = `[NO_PRIORITY]`, `project-quality-summary` =
  13 issues, avg 94/100 (A), 11 READY / 1 NEEDS_WORK / 1 BLOCKED,
  `list-data-debt` worst-first starting at DEMO-5 (41, P0). The harness
  reproduces the exact handler logic in `src/index.js` with demo data
  standing in for the Jira fetch.
- The remote transport was probed the same day: `POST` to the MCP URL
  returns HTTP 401 (auth required) and the official MCP Inspector
  reports `auth_required` / "Interactive OAuth requires a TTY".
- **Not yet done:** a full end-to-end tool call from a third-party
  client (Claude Code / Cursor) against the live site. That needs an
  interactive Atlassian OAuth sign-in, which cannot be done from a
  non-interactive shell. Do not claim it was tested until someone runs
  step 3–4 above and sees a real tool result.

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
- The project page can export the current audit as a CSV file or as a
  Markdown report, and shows a "Fix first — top 5 priority issues" list
  (P0/P1/P2, worst first).
- Scores are deterministic: same issue data, same score, every time.
  No LLM is involved anywhere in the audit.

## Rules for the agent

- Quote only numbers the tools return. Never invent a score.
- A score below 50 is BLOCKED, 50–69 NEEDS_WORK, 70+ READY (and no critical findings).
- Dimensions: completeness 30, ownership 20, planning 15, labels 15, freshness 10, linkage 10.
- Duplicates are found by word-level Jaccard similarity on title and on
  summary + description (higher of the two; >= 0.7 = likely duplicate,
  0.5–0.7 = similar, not a duplicate).
- Always confirm with the user before calling `apply-fixes` or
  `bulk-apply-fixes`.
