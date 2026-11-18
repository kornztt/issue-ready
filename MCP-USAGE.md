# IssueReady MCP — how to connect from a third-party client

> App: **IssueReady** (Jira data-quality auditor, Codegeist 2026).
> Deployed app id: `24c0092e-8290-46cc-9c49-7cc478bdf9a9`
> (matches `app.id` in `issue-ready/manifest.yml`).
> MCP server URL: `https://mcp.atlassian.com/forge/24c0092e-8290-46cc-9c49-7cc478bdf9a9`
> Repo: https://github.com/kornztt/issue-ready (`skill.md` is the
> machine-readable version of this page).

## What it is

IssueReady scores every Jira issue 0–100 with deterministic, explainable
rules (completeness 30, ownership 20, planning 15, labels/taxonomy 15,
freshness 10, linkage 10) — no LLM, no guessing. The same engine powers
the Jira project page, the issue panel, the Rovo agent and this MCP
server, so the numbers an agent quotes are the numbers the project page
shows.

## Prerequisites

1. IssueReady installed on your Atlassian site (use the install link from
   the Devpost submission).
2. The site admin enables external tools: Admin > Apps > Sites > `<site>`
   \> Connected apps > IssueReady > Tools.
3. An Atlassian account with access to that site — the MCP server asks
   you to sign in with OAuth when your client first connects. Until you
   do, the server answers HTTP 401. That is expected, not a bug.

## Connect

### Claude Code

```bash
claude mcp add --transport http issue-ready https://mcp.atlassian.com/forge/24c0092e-8290-46cc-9c49-7cc478bdf9a9
```

Then sign in with your Atlassian account when prompted, and try:

```
How healthy is this project's Jira data?
```

### Cursor

Settings > Tools & Integrations > New MCP Server, or add to
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "issue-ready": {
      "url": "https://mcp.atlassian.com/forge/24c0092e-8290-46cc-9c49-7cc478bdf9a9"
    }
  }
}
```

Restart Cursor (or refresh the MCP list), sign in with your Atlassian
account when prompted, then ask in Agent mode: "What is blocking triage?"

### VS Code (Copilot)

Add to your MCP config (`.vscode/mcp.json` or user settings):

```json
{
  "servers": {
    "issue-ready": {
      "type": "http",
      "url": "https://mcp.atlassian.com/forge/24c0092e-8290-46cc-9c49-7cc478bdf9a9"
    }
  }
}
```

Start the server, sign in with your Atlassian account, then ask Copilot
in Agent mode: "Audit DEMO-3 and tell me how to fix it."

## Tools (6)

| Tool | What it does | Example prompt |
|---|---|---|
| `audit-issue` | Score ONE issue 0–100 + every failed check | "Is DEMO-3 ready for triage?" |
| `list-data-debt` | Worst-scoring open issues, worst first | "What is blocking triage?" |
| `project-quality-summary` | Project average, grades, verdicts, top problems, duplicates | "How healthy is this project's Jira data?" |
| `suggest-fixes` | Safe one-click fixes for one issue (read-only) | "How do I fix DEMO-3?" |
| `apply-fixes` | Applies the safe fixes (priority, label normalisation) | Only after the user confirms |
| `bulk-apply-fixes` | Applies the safe fixes to EVERY fixable issue; reports fixed + skipped | Only after the user confirms |

Rules for the agent using these tools:

- Quote only numbers the tools return. Never invent a score.
- Verdicts: score >= 70 and no critical finding = READY; 50–69 =
  NEEDS_WORK; below 50 = BLOCKED. Grades: A >= 85, B >= 70, C >= 50,
  D < 50.
- Duplicates: word-level Jaccard on title and on summary + description,
  higher of the two; >= 0.7 = likely duplicate, 0.5–0.7 = similar.
- Always confirm with the user before `apply-fixes` or
  `bulk-apply-fixes`. Read-only tools need no confirmation.

## Verification status (2026-11-17, honest)

- **Tool logic verified locally.** A Node harness
  (`/tmp/mcp-harness.mjs`, reproduces the exact handler logic in
  `src/index.js` with the shipped demo data) returns:
  - `audit-issue` DEMO-3 → 85/100, grade A, NEEDS_WORK, 2 findings
    (both with problem/how/outcome guidance);
  - `suggest-fixes` DEMO-5 → `[NO_PRIORITY]` (the only demo issue
    with an auto-fixable finding; DEMO-3 correctly returns `[]`
    because "no assignee" and "no repro steps" are not auto-fixable);
  - `project-quality-summary` → 13 issues, average 94/100 (A),
    11 READY / 1 NEEDS_WORK / 1 BLOCKED, priority queue starting at
    DEMO-5 (41, P0);
  - `list-data-debt` (limit 5) → DEMO-5 (41, P0), DEMO-3 (85, P1),
    DEMO-4 (97, P2), DEMO-13 (97, P2), DEMO-1 (100, P2), worst first.
- **Remote transport probed, not yet fully called.** `POST` to the MCP
  URL returns HTTP 401 (auth required) and the official MCP Inspector
  reports `auth_required` / "Interactive OAuth requires a TTY".
  A full end-to-end tool call from Claude Code / Cursor / VS Code
  against the live site still needs someone to complete the
  interactive Atlassian OAuth sign-in in the client. That step cannot
  be done from a non-interactive shell, so it is **not** claimed as
  tested here. Run the Connect steps above and you should see a real
  tool result within a minute.

## Troubleshooting

- **401 on first connect** — normal. Complete the Atlassian OAuth
  sign-in in your MCP client and retry.
- **Tools don't appear** — check the app id in the URL matches
  `24c0092e-8290-46cc-9c49-7cc478bdf9a9`, and that the site admin
  enabled external tools for IssueReady (see Prerequisites).
- **"Issue not found"** — the tool talks to your site's real Jira
  data. `DEMO-3` / `DEMO-5` only exist in the demo data set loaded
  from the project page; on a real project, use your own issue keys.
