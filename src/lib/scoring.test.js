import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreIssue, scoreProject, findDuplicates, tokenize, jaccard, daysBetween,
  severityFor, guidanceFor,
} from './scoring.js';

const NOW = '2026-11-17T00:00:00.000Z';
const good = {
  key: 'DEMO-1', summary: 'Login page returns 500 for SSO users',
  description: 'Steps to reproduce: 1. Log in with SSO. 2. Open /login. Expected: dashboard. Actual: 500 error page.',
  status: 'In Progress', priority: 'High', assignee: 'ana', reporter: 'bob',
  labels: ['auth', 'login'], components: ['web'], issueType: 'Bug',
  created: '2026-11-10T00:00:00.000Z', updated: '2026-11-16T00:00:00.000Z',
  duedate: '2026-11-20', estimate: 3, parentKey: null,
  linkedIssueKeys: ['DEMO-2'], commentsCount: 2,
};

test('perfect issue scores 100 / grade A / READY', () => {
  const r = scoreIssue(good, { now: NOW });
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.verdict, 'READY');
  assert.deepEqual(r.findings, []);
});

test('empty issue scores low and is BLOCKED', () => {
  const r = scoreIssue({
    key: 'DEMO-2', summary: '', description: '', status: 'To Do',
    priority: null, assignee: null, reporter: null, labels: [], components: [],
    issueType: 'Task', created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-05T00:00:00.000Z', duedate: null, estimate: null,
    parentKey: null, linkedIssueKeys: [], commentsCount: 0,
  }, { now: NOW });
  assert.ok(r.score < 50, `expected <50, got ${r.score}`);
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.grade, 'D');
  const codes = r.findings.map((f) => f.code);
  for (const c of ['NO_SUMMARY', 'NO_DESCRIPTION', 'NO_ASSIGNEE', 'NO_PRIORITY', 'NO_LABELS', 'STALE_90D']) {
    assert.ok(codes.includes(c), `missing finding ${c}: ${codes}`);
  }
});

test('bug without repro steps loses completeness points', () => {
  const r = scoreIssue({ ...good, description: 'Login is broken.' }, { now: NOW });
  assert.ok(r.findings.some((f) => f.code === 'BUG_NO_REPRO_STEPS'));
  assert.ok(r.findings.some((f) => f.code === 'DESCRIPTION_TOO_SHORT'));
  assert.equal(r.score, 100 - 3 - 6);
});

test('missing priority carries a fix suggestion', () => {
  const r = scoreIssue({ ...good, priority: null }, { now: NOW });
  const f = r.findings.find((x) => x.code === 'NO_PRIORITY');
  assert.ok(f);
  assert.deepEqual(f.fix, { type: 'set-priority', priority: 'Medium' });
});

test('inconsistent label casing is flagged with a normalize fix', () => {
  const r = scoreIssue({ ...good, labels: ['Auth', 'login page'] }, { now: NOW });
  const f = r.findings.find((x) => x.code === 'LABEL_CASE');
  assert.ok(f);
  assert.equal(f.fix.type, 'normalize-labels');
});

test('stale thresholds: 30d warns, 90d is critical', () => {
  const d30 = scoreIssue({ ...good, updated: '2026-10-01T00:00:00.000Z' }, { now: NOW });
  assert.ok(d30.findings.some((f) => f.code === 'STALE_30D'));
  const d90 = scoreIssue({ ...good, updated: '2026-08-01T00:00:00.000Z' }, { now: NOW });
  assert.ok(d90.findings.some((f) => f.code === 'STALE_90D' && f.severity === 'critical'));
});

test('done issues are not penalised for staleness', () => {
  const r = scoreIssue({ ...good, status: 'Done', updated: '2026-01-01T00:00:00.000Z' }, { now: NOW });
  assert.ok(!r.findings.some((f) => f.code.startsWith('STALE')));
});

test('duplicate detection: near-identical summaries score high, unrelated score 0', () => {
  const a = { key: 'A', summary: 'Checkout fails with expired credit card', description: 'Payment gateway returns error on expired cards at checkout' };
  const b = { key: 'B', summary: 'Checkout fails with expired credit card', description: 'Payment gateway returns error on expired cards at checkout' };
  const c = { key: 'C', summary: 'Update onboarding email copy', description: 'Rewrite welcome email for new users' };
  const pairs = findDuplicates([a, b, c]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 'A');
  assert.equal(pairs[0].b, 'B');
  assert.equal(pairs[0].similarity, 1);
  assert.equal(pairs[0].likelyDuplicate, true);
});

test('duplicate detection: reworded near-duplicate scores >= 0.7, merely similar does not', () => {
  const a = { key: 'A', summary: 'Checkout fails with expired credit card', description: 'Payment gateway returns an error on expired cards at checkout and the user sees a blank page.' };
  // Same problem, reworded title and description — no two strings identical.
  const b = { key: 'B', summary: 'Checkout fails for expired credit cards on mobile', description: 'When a card has expired, the payment gateway returns an error at checkout and the user sees a blank page instead of an error message.' };
  // Same area (settings page) but a different request — must NOT be a duplicate.
  const c = { key: 'C', summary: 'Add dark mode to settings page', description: 'Add a dark-mode toggle to the settings page and persist the choice per user.' };
  const d = { key: 'D', summary: 'Settings page redesign', description: 'Redesign the settings page layout for clarity. See the design doc linked in comments.' };
  const pairs = findDuplicates([a, b, c, d]);
  const ab = pairs.find((p) => p.a === 'A' && p.b === 'B');
  assert.ok(ab, 'reworded pair should be listed');
  assert.ok(ab.similarity >= 0.7 && ab.similarity < 1, `expected 0.7<=sim<1, got ${ab.similarity}`);
  assert.equal(ab.likelyDuplicate, true);
  const cd = pairs.find((p) => p.a === 'C' && p.b === 'D');
  assert.ok(!cd || cd.likelyDuplicate === false, 'same-area pair must not be a likely duplicate');
});

test('CSV export: header, one row per issue, quoting', async () => {
  const { toCsv } = await import('./csv.js');
  const report = {
    audits: [
      { key: 'A-1', score: 91, grade: 'A', verdict: 'READY', findings: [] },
      { key: 'A-2', score: 60, grade: 'C', verdict: 'NEEDS_WORK', findings: [{ message: 'No priority set — triage cannot rank this issue.' }] },
      { key: 'A-3', score: 40, grade: 'D', verdict: 'BLOCKED', findings: [{ message: 'Say "hello", then fix it' }] },
    ],
  };
  const csv = toCsv(report);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Issue,Score,Grade,Verdict,Top finding');
  assert.equal(lines[1], 'A-1,91,A,READY,No findings');
  assert.equal(lines[2], 'A-2,60,C,NEEDS_WORK,No priority set — triage cannot rank this issue.');
  assert.equal(lines[3], 'A-3,40,D,BLOCKED,"Say ""hello"", then fix it"');
  assert.equal(lines.length, 4);
});

test('audit history: snapshots append, cap at 20, delta needs two', async () => {
  const { buildSnapshot, appendSnapshot, trendDelta } = await import('./history.js');
  const snap = (avg) => buildSnapshot({ averageScore: avg, total: 5, byVerdict: { READY: 3, NEEDS_WORK: 1, BLOCKED: 1 } }, '2026-11-17T00:00:00.000Z');
  let h = appendSnapshot([], snap(80));
  assert.equal(h.length, 1);
  assert.equal(trendDelta(h), null);
  h = appendSnapshot(h, snap(84));
  assert.equal(trendDelta(h), 4);
  for (let i = 0; i < 25; i++) h = appendSnapshot(h, snap(80 + i));
  assert.equal(h.length, 20);
  assert.equal(h[19].averageScore, 104);
});

test('tokenize drops stopwords and short tokens', () => {
  assert.deepEqual(tokenize('The login page fails'), ['login', 'page']);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('daysBetween handles bad input', () => {
  assert.equal(daysBetween(null, NOW), null);
  assert.equal(daysBetween('not-a-date', NOW), null);
  assert.equal(Math.floor(daysBetween('2026-11-10T00:00:00.000Z', NOW)), 7);
});

test('project roll-up: averages, grades, top problems, worst list', () => {
  const bad = { ...good, key: 'DEMO-9', summary: 'x', description: '', assignee: null, priority: null, labels: [], updated: '2026-01-01T00:00:00.000Z' };
  const p = scoreProject([good, bad], { now: NOW });
  assert.equal(p.total, 2);
  assert.equal(p.averageScore, Math.round((100 + scoreIssue(bad, { now: NOW }).score) / 2));
  assert.equal(p.byVerdict.READY, 1);
  assert.equal(p.byVerdict.BLOCKED, 1);
  assert.equal(p.worst[0].key, 'DEMO-9');
  assert.ok(p.topProblems.length > 0);
  assert.ok(p.fixableFindings >= 1);
});

test('severityFor: BLOCKED or score < 40 is P0, NEEDS_WORK is P1, READY is P2', () => {
  assert.equal(severityFor(14, 'BLOCKED'), 'P0');
  assert.equal(severityFor(45, 'BLOCKED'), 'P0');
  assert.equal(severityFor(39, 'NEEDS_WORK'), 'P0'); // score < 40 wins over verdict
  assert.equal(severityFor(59, 'NEEDS_WORK'), 'P1');
  assert.equal(severityFor(88, 'NEEDS_WORK'), 'P1');
  assert.equal(severityFor(97, 'READY'), 'P2');
  assert.equal(guidanceFor('NOT_A_CODE'), null);
});

test('priority queue: P0 first, then P1, then P2, lowest score first in each tier, capped at 5', () => {
  const empty = {
    key: 'Q-P0', summary: '', description: '', status: 'To Do',
    priority: null, assignee: null, reporter: null, labels: [], components: [],
    issueType: 'Task', created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-05T00:00:00.000Z', duedate: null, estimate: null,
    parentKey: null, linkedIssueKeys: [], commentsCount: 0,
  };
  const p1Low = { ...good, key: 'Q-P1-LOW', assignee: null, priority: null, labels: [], components: [], estimate: null, duedate: null, linkedIssueKeys: [] };
  const p1High = { ...good, key: 'Q-P1-HIGH', assignee: null };
  const p2 = { ...good, key: 'Q-P2', linkedIssueKeys: [] };
  const extra = ['Q-X1', 'Q-X2', 'Q-X3'].map((k) => ({ ...good, key: k, linkedIssueKeys: [] }));
  const p = scoreProject([p2, p1High, empty, p1Low, ...extra], { now: NOW });
  assert.equal(p.priorityQueue.length, 5);
  assert.deepEqual(p.priorityQueue.map((q) => q.key), ['Q-P0', 'Q-P1-LOW', 'Q-P1-HIGH', 'Q-P2', 'Q-X1']);
  assert.deepEqual(p.priorityQueue.map((q) => q.severity), ['P0', 'P1', 'P1', 'P2', 'P2']);
  assert.ok(p.priorityQueue[0].score < p.priorityQueue[1].score);
  assert.ok(p.priorityQueue[1].score < p.priorityQueue[2].score);
  assert.ok(p.priorityQueue[0].topFinding.length > 0);
  assert.ok(p.priorityQueue[0].topGuidance && p.priorityQueue[0].topGuidance.how.length > 0);
});

test('every finding code carries three-part guidance (problem / how / outcome)', () => {
  const cases = [
    { key: 'G-EMPTY', summary: '', description: '', status: 'To Do', priority: null, assignee: null, reporter: null, labels: [], components: [], issueType: 'Task', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-05T00:00:00.000Z', duedate: null, estimate: null, parentKey: null, linkedIssueKeys: [], commentsCount: 0 },
    { ...good, key: 'G-SHORT', summary: 'x', description: 'Short text.' },
    { ...good, key: 'G-LABELS', labels: ['Auth', 'auth', 'login page'] },
    { ...good, key: 'G-STALE', updated: '2026-10-01T00:00:00.000Z' },
    { ...good, key: 'G-SUB', issueType: 'Sub-task', parentKey: null, linkedIssueKeys: [] },
  ];
  const seen = new Set();
  for (const c of cases) {
    for (const f of scoreIssue(c, { now: NOW }).findings) {
      seen.add(f.code);
      assert.ok(f.guidance, `${f.code} has no guidance`);
      for (const field of ['problem', 'how', 'outcome']) {
        assert.equal(typeof f.guidance[field], 'string', `${f.code} guidance.${field} not a string`);
        assert.ok(f.guidance[field].length > 10, `${f.code} guidance.${field} too short`);
      }
      assert.ok(!('guidanceCtx' in f), `${f.code} leaks guidanceCtx`);
    }
  }
  const allCodes = ['NO_SUMMARY', 'SUMMARY_TOO_SHORT', 'NO_DESCRIPTION', 'DESCRIPTION_TOO_SHORT', 'BUG_NO_REPRO_STEPS', 'NO_ASSIGNEE', 'NO_REPORTER', 'NO_PRIORITY', 'NO_ESTIMATE', 'NO_DUE_DATE', 'NO_LABELS', 'LABEL_CASE', 'DUPLICATE_LABELS', 'NO_COMPONENT', 'STALE_30D', 'STALE_90D', 'SUBTASK_NO_PARENT', 'NO_LINKS'];
  for (const code of allCodes) {
    assert.ok(seen.has(code), `no test issue produced ${code}`);
  }
});

test('history snapshots are unaffected by the new report fields', async () => {
  const { buildSnapshot } = await import('./history.js');
  const p = scoreProject([good], { now: NOW });
  assert.ok(Array.isArray(p.priorityQueue));
  const snap = buildSnapshot(p, '2026-11-17T00:00:00.000Z');
  assert.deepEqual(Object.keys(snap).sort(), ['at', 'averageScore', 'byVerdict', 'total']);
});

test('Markdown report: project, average, grade distribution, Top 5, failures by dimension, export time', async () => {
  const { toMarkdown } = await import('./md-report.js');
  const bad = { ...good, key: 'M-9', summary: 'x', description: '', assignee: null, priority: null, labels: [], updated: '2026-01-01T00:00:00.000Z' };
  const p = scoreProject([good, bad], { now: NOW });
  const md = toMarkdown(p, { projectKey: 'DEMO', exportedAt: '2026-11-17T00:00:00.000Z' });
  assert.ok(md.includes('# IssueReady audit report — DEMO'));
  assert.ok(md.includes('Exported: 2026-11-17T00:00:00.000Z'));
  assert.ok(md.includes(`Average score: ${p.averageScore}/100 (grade ${p.grade})`));
  assert.ok(md.includes('Grades — A: 1'));
  assert.ok(md.includes('## Top 5 priority fixes'));
  assert.ok(md.includes('**M-9** — P0'));
  assert.ok(md.includes('## Failures by dimension'));
  assert.ok(md.includes('**ownership**'));
  assert.ok(md.includes('NO_ASSIGNEE: 1'));
});

test('Markdown report: clean project reports no fixes and no failed checks', async () => {
  const { toMarkdown } = await import('./md-report.js');
  const p = scoreProject([good], { now: NOW });
  const md = toMarkdown(p, { projectKey: 'DEMO', exportedAt: '2026-11-17T00:00:00.000Z' });
  assert.ok(md.includes('No issues need fixing'));
  assert.ok(md.includes('No failed checks.'));
});
