import { makeResolver } from '@forge/resolver';
import { asApp, asUser, route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { scoreIssue, scoreProject, severityFor } from './lib/scoring.js';
import { DEMO_ISSUES } from './lib/demo-data.js';
import { toCsv } from './lib/csv.js';
import { toMarkdown } from './lib/md-report.js';
import { buildSnapshot, appendSnapshot, HISTORY_LIMIT } from './lib/history.js';

// KVS keys:
//   audit:<issueKey>          latest per-issue audit (from actions + triggers)
//   history:<projectKey>      capped list (<=20) of audit snapshots
//   audited-projects          project keys the weekly audit should cover

// ------------------------------------------------------------------ Jira mapping
// Jira REST v3 issue -> the plain shape src/lib/scoring.js understands.
function toIssueShape(j) {
  const f = j.fields || {};
  const linked = [];
  (f.issuelinks || []).forEach((l) => {
    if (l.outwardIssue) linked.push(l.outwardIssue.key);
    if (l.inwardIssue) linked.push(l.inwardIssue.key);
  });
  // Story points live in a custom field whose id varies by site; try the
  // common ones and fall back to null (missing estimate is a finding, not an error).
  const estimate =
    f.customfield_10016 ?? f.customfield_10026 ?? f.customfield_10005 ?? null;
  return {
    key: j.key,
    summary: f.summary || '',
    description: f.description || '',
    status: f.status?.name || '',
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    issueType: f.issuetype?.name || 'Task',
    created: f.created,
    updated: f.updated,
    duedate: f.duedate || null,
    estimate: typeof estimate === 'number' ? estimate : null,
    parentKey: f.parent?.key || null,
    linkedIssueKeys: linked,
    commentsCount: f.comment?.total ?? 0,
  };
}

async function fetchProjectIssues(projectKey, useAsApp = false) {
  const jira = useAsApp ? asApp() : asUser();
  const res = await jira.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jql: `project = ${projectKey} ORDER BY updated DESC`,
      maxResults: 100,
      fields: [
        'summary', 'description', 'status', 'priority', 'assignee', 'reporter',
        'labels', 'components', 'issuetype', 'created', 'updated', 'duedate',
        'parent', 'issuelinks', 'comment', 'customfield_10016',
        'customfield_10026', 'customfield_10005',
      ],
    }),
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status}`);
  const data = await res.json();
  return (data.issues || []).map(toIssueShape);
}

async function fetchIssue(issueKey) {
  const res = await asUser().requestJira(route`/rest/api/3/issue/${issueKey}`);
  if (!res.ok) throw new Error(`Jira issue ${issueKey} not found: ${res.status}`);
  return toIssueShape(await res.json());
}

function normaliseLabel(label) {
  return label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function applyFixToIssue(issueKey, fixType) {
  const issue = await fetchIssue(issueKey);
  const applied = [];
  if (fixType === 'set-priority' || fixType === 'all') {
    if (!issue.priority) {
      await asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { priority: { name: 'Medium' } } }),
      });
      applied.push('set priority to Medium');
    }
  }
  if (fixType === 'normalize-labels' || fixType === 'all') {
    const fixed = [...new Set(issue.labels.map(normaliseLabel))];
    if (JSON.stringify(fixed) !== JSON.stringify(issue.labels)) {
      await asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { labels: fixed } }),
      });
      applied.push(`normalised labels to ${fixed.join(', ')}`);
    }
  }
  if (fixType === 'post-audit-comment' || fixType === 'all') {
    const audit = scoreIssue(issue);
    const lines = audit.findings.map((f) => `- [${f.severity}] ${f.code}: ${f.message}`).join('\n');
    await asUser().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          type: 'doc', version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: `IssueReady audit: ${audit.score}/100 (${audit.grade}, ${audit.verdict}).\n${lines || 'No findings — this issue is ready for triage.'}` }],
          }],
        },
      }),
    });
    applied.push('posted audit summary as a comment');
  }
  return { issueKey, applied, after: scoreIssue(await fetchIssue(issueKey)) };
}

// ------------------------------------------------------------------ audit history (KVS)
// Every project audit appends one snapshot; the weekly scheduled audit
// keeps the history growing even when nobody opens the project page.
async function recordSnapshot(projectKey, report) {
  try {
    const key = `history:${projectKey}`;
    const history = (await kvs.get(key)) || [];
    await kvs.set(key, appendSnapshot(history, buildSnapshot(report)));
    const tracked = (await kvs.get('audited-projects')) || [];
    if (!tracked.includes(projectKey)) {
      await kvs.set('audited-projects', [...tracked, projectKey]);
    }
  } catch (e) {
    console.log(`IssueReady: could not record snapshot for ${projectKey}: ${e.message}`);
  }
}

async function auditProject(projectKey, useAsApp = false) {
  const issues = await fetchProjectIssues(projectKey, useAsApp);
  const report = scoreProject(issues);
  await recordSnapshot(projectKey, report);
  return report;
}

// ------------------------------------------------------------------ UI resolver
// Named import (makeResolver) on purpose: the deployed bundle crashed at
// `new Resolver()` with "out_namespaceObject is not a constructor", i.e.
// the bundler's default-import interop for @forge/resolver. makeResolver
// takes the same handlers object and returns the definitions.
export const handler = makeResolver({
  getProjectAudit: async ({ payload }) => {
    return auditProject(payload.projectKey);
  },

  getAuditHistory: async ({ payload }) => {
    const history = (await kvs.get(`history:${payload.projectKey}`)) || [];
    return { projectKey: payload.projectKey, history, limit: HISTORY_LIMIT };
  },

  // Exports return file content directly through the authenticated resolver
  // (no public webtrigger URL): only a logged-in Jira user with access to
  // the project can download a report. fetchProjectIssues defaults to
  // asUser, so the export also respects the caller's own permissions.
  getCsvExport: async ({ payload }) => {
    const issues = await fetchProjectIssues(payload.projectKey);
    return {
      filename: `issue-ready-${payload.projectKey}-audit.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(scoreProject(issues)),
    };
  },

  getMdExport: async ({ payload }) => {
    const issues = await fetchProjectIssues(payload.projectKey);
    return {
      filename: `issue-ready-${payload.projectKey}-audit.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: toMarkdown(scoreProject(issues), { projectKey: payload.projectKey }),
    };
  },

  applyFixAll: async ({ payload }) => bulkApplyFixes(payload),

  getDemoAudit: async () => scoreProject(DEMO_ISSUES),

  getIssueAudit: async ({ payload }) => {
    const issue = await fetchIssue(payload.issueKey);
    return scoreIssue(issue);
  },

  getDemoIssueAudit: async ({ payload }) => {
    const issue = DEMO_ISSUES.find((i) => i.key === payload.issueKey);
    if (!issue) throw new Error(`Demo issue ${payload.issueKey} not found`);
    return scoreIssue(issue);
  },

  applyFix: async ({ payload }) => applyFixToIssue(payload.issueKey, payload.fixType),
});

// ------------------------------------------------------------------ Rovo actions
// Each action returns plain JSON the agent can quote. Scores are always
// computed by src/lib/scoring.js — the agent never invents a number.
export async function auditIssue(payload) {
  const issue = await fetchIssue(payload.issueKey);
  const audit = scoreIssue(issue);
  await kvs.set(`audit:${issue.key}`, { ...audit, at: new Date().toISOString() });
  return audit;
}

export async function listDataDebt(payload) {
  const limit = Math.min(Math.max(payload.limit || 5, 1), 20);
  const issues = await fetchProjectIssues(payload.projectKey);
  const report = scoreProject(issues);
  return {
    projectKey: payload.projectKey,
    averageScore: report.averageScore,
    worst: report.worst.slice(0, limit).map((a) => ({
      key: a.key, score: a.score, grade: a.grade, verdict: a.verdict,
      severity: severityFor(a.score, a.verdict),
      topFinding: a.findings[0]?.message || 'No findings',
      topGuidance: a.findings[0]?.guidance || null,
    })),
  };
}

export async function projectSummary(payload) {
  const issues = await fetchProjectIssues(payload.projectKey);
  const r = scoreProject(issues);
  return {
    projectKey: payload.projectKey,
    total: r.total,
    averageScore: r.averageScore,
    grade: r.grade,
    byVerdict: r.byVerdict,
    byGrade: r.byGrade,
    topProblems: r.topProblems,
    likelyDuplicates: r.likelyDuplicates,
    duplicates: r.duplicates,
    fixableFindings: r.fixableFindings,
    priorityQueue: r.priorityQueue,
  };
}

export async function suggestFixes(payload) {
  const issue = await fetchIssue(payload.issueKey);
  const audit = scoreIssue(issue);
  return {
    issueKey: issue.key,
    score: audit.score,
    // Same three-part guidance the issue panel shows (problem / how /
    // outcome), so the agent quotes the engine's text, never its own.
    fixes: audit.findings.filter((f) => f.fix).map((f) => ({
      code: f.code, message: f.message, fix: f.fix, guidance: f.guidance,
    })),
  };
}

export async function applyFixes(payload) {
  return applyFixToIssue(payload.issueKey, 'all');
}

// Bulk fix: runs the same safe one-click fixes on every fixable issue in
// a project. Issues with nothing fixable are reported as skipped, never
// touched — so the result is an auditable per-issue list, not a blind sweep.
export async function bulkApplyFixes(payload) {
  const issues = await fetchProjectIssues(payload.projectKey);
  const report = scoreProject(issues);
  const results = [];
  let fixedCount = 0;
  for (const audit of report.audits) {
    if (!audit.findings.some((f) => f.fix)) {
      results.push({ issueKey: audit.key, score: audit.score, applied: [], skipped: true });
      continue;
    }
    try {
      const r = await applyFixToIssue(audit.key, 'all');
      fixedCount++;
      results.push({ issueKey: r.issueKey, score: r.after.score, applied: r.applied, skipped: false });
    } catch (e) {
      results.push({ issueKey: audit.key, score: audit.score, applied: [], skipped: true, error: e.message });
    }
  }
  await recordSnapshot(payload.projectKey, scoreProject(await fetchProjectIssues(payload.projectKey)));
  return {
    projectKey: payload.projectKey,
    total: report.total,
    fixedCount,
    skippedCount: results.length - fixedCount,
    results,
  };
}

// ------------------------------------------------------------------ scheduled trigger
// Weekly audit (Forge `week` interval runs on Mondays): re-audits every
// project that has been audited at least once and records a snapshot, so
// the trend on the project page stays fresh without anyone opening it.
export async function weeklyAudit() {
  const tracked = (await kvs.get('audited-projects')) || [];
  const audited = [];
  for (const projectKey of tracked) {
    try {
      await auditProject(projectKey, true);
      audited.push(projectKey);
    } catch (e) {
      console.log(`IssueReady weekly audit failed for ${projectKey}: ${e.message}`);
    }
  }
  return { audited };
}

// ------------------------------------------------------------------ trigger
// Runs as the app on issue create/update. Scores the issue and stores the
// audit; never throws (a failed audit must not break the Jira event).
export async function onIssueEvent(event) {
  try {
    const key = event?.issue?.key;
    if (!key) return;
    const res = await asApp().requestJira(route`/rest/api/3/issue/${key}`);
    if (!res.ok) return;
    const audit = scoreIssue(toIssueShape(await res.json()));
    await kvs.set(`audit:${key}`, { ...audit, at: new Date().toISOString() });
  } catch (e) {
    console.log(`IssueReady trigger failed for event: ${e.message}`);
  }
}
