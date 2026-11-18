/**
 * IssueReady scoring engine — PURE module.
 *
 * No Forge imports, no network, no LLM, no dates from the environment except
 * the caller-supplied `now` (so tests are deterministic).
 *
 * Input issue shape (subset of Jira REST v3 issue fields, as returned by
 * /rest/api/3/search/jql — only the fields we read are listed):
 *   { key, summary, description, status, priority, assignee, reporter,
 *     labels[], components[], issueType, created, updated, duedate,
 *     estimate (story points, number|null), parentKey, linkedIssueKeys[],
 *     commentsCount }
 *
 * Output: { score 0-100, grade A|B|C|D, verdict READY|NEEDS_WORK|BLOCKED,
 *           dimensions: { completeness, ownership, planning, taxonomy,
 *                         freshness, linkage }, findings: [...] }
 *
 * A finding: { code, severity: 'critical'|'warning'|'info',
 *              dimension, message, guidance: { problem, how, outcome } | null,
 *              fix: null | { type, label?, priority?, comment? } }
 * `severityFor(score, verdict)` maps an audit to a fix priority P0/P1/P2;
 * `scoreProject` also returns `priorityQueue` (top 5 issues with findings,
 * P0 first, lowest score first within each tier).
 */

// ---------------------------------------------------------------- weights
export const DIMENSION_WEIGHTS = {
  completeness: 30,
  ownership: 20,
  planning: 15,
  taxonomy: 15,
  freshness: 10,
  linkage: 10,
};

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'be', 'it', 'this', 'that', 'not', 'no', 'when', 'after',
  'please', 'fix', 'bug', 'issue', 'error', 'problem', 'fail', 'fails',
  'failed', 'broken', 'does', 'do', 'did', 'can', 'cannot', 'cant', 'very',
  'should', 'would', 'could', 'as', 'at', 'by', 'from', 'into', 'about',
]);

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Days between two ISO dates (fractional, floored at 0 for future dates). */
export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso) - new Date(fromIso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, ms / 86400000);
}

function plainTextLength(description) {
  if (!description) return 0;
  if (typeof description === 'string') return description.trim().length;
  // ADF (Atlassian Document Format): walk content nodes for text.
  let out = '';
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') out += node.text + ' ';
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(description);
  return out.trim().length;
}

function hasWord(text, words) {
  const low = (text || '').toLowerCase();
  return words.some((w) => low.includes(w));
}

// ------------------------------------------------------------- fix guidance
// Every finding carries a three-part `guidance` object — problem, how to
// fix it in Jira, and what the score looks like afterwards — so the issue
// panel, the Rovo agent and the MCP tools all quote the same text.
// Only real Jira operations are named (edit a field, assign, link, close);
// nothing is invented. "Restores up to N points" is the exact amount
// docked for that finding; "up to" covers overlaps (e.g. a longer
// description can also fix the missing-repro-steps finding).
const GUIDANCE_BUILDERS = {
  NO_SUMMARY: () => ({
    problem: 'No summary — the issue is invisible on boards and in search, and triage cannot tell what it is about.',
    how: 'Open the issue and write a one-line summary: what is wanted and where it happens (for example "Login page returns 500 for SSO users").',
    outcome: 'Adding a summary restores up to 15 completeness points.',
  }),
  SUMMARY_TOO_SHORT: ({ summaryLength }) => ({
    problem: `Summary is only ${summaryLength} characters — too short to say what the issue is about.`,
    how: 'Rewrite the summary to at least 10 characters naming the feature and the problem (for example "Checkout fails for expired cards").',
    outcome: 'A clear summary restores up to 8 completeness points.',
  }),
  NO_DESCRIPTION: () => ({
    problem: 'No description — triage cannot tell what is wanted, what was tried, or what "done" looks like.',
    how: 'Open the issue and write a description: what should happen, what actually happens, and any context or links.',
    outcome: 'Adding a description restores up to 12 completeness points.',
  }),
  DESCRIPTION_TOO_SHORT: ({ descLength }) => ({
    problem: `Description is only ${descLength} characters — not enough detail to act on.`,
    how: 'Expand the description to at least 40 characters: add the expected behaviour and the steps or context behind the request.',
    outcome: 'A fuller description restores up to 6 completeness points.',
  }),
  BUG_NO_REPRO_STEPS: () => ({
    problem: 'A bug with no reproduction steps — nobody can reliably reproduce it or verify a fix.',
    how: 'Add steps to reproduce plus expected and actual behaviour to the description (for example "Steps: 1. Log in with SSO. 2. Open /login. Expected: dashboard. Actual: 500 error page.").',
    outcome: 'Reproduction steps restore up to 3 completeness points.',
  }),
  NO_ASSIGNEE: () => ({
    problem: 'No assignee — nobody owns this issue, so it will sit in the backlog untouched.',
    how: 'Open the issue and set the Assignee field to the person who should do the work.',
    outcome: 'Assigning an owner restores up to 12 ownership points.',
  }),
  NO_REPORTER: () => ({
    problem: 'No reporter recorded — if a question comes up, nobody knows who asked for this.',
    how: 'Set the Reporter field to the person who raised the issue.',
    outcome: 'A reporter restores up to 8 ownership points.',
  }),
  NO_PRIORITY: () => ({
    problem: 'No priority — triage cannot rank this issue against the rest of the backlog.',
    how: 'Set the Priority field. The one-click fix sets Medium; raise it to High if the issue blocks a release or a customer.',
    outcome: 'Setting a priority restores up to 8 planning points. One-click fix available.',
  }),
  NO_ESTIMATE: () => ({
    problem: 'No story-point estimate — sprint planning cannot size this work.',
    how: 'Add an estimate in the Story Points field (or the estimate field your team uses).',
    outcome: 'An estimate restores up to 4 planning points.',
  }),
  NO_DUE_DATE: () => ({
    problem: 'No due date on an open issue — nothing forces a decision about when it should be done.',
    how: 'Set a due date in the Due Date field.',
    outcome: 'A due date restores up to 3 planning points.',
  }),
  NO_LABELS: () => ({
    problem: 'No labels — the issue is invisible to label-based triage, filters and reports.',
    how: "Add at least one lowercase-hyphen label naming the area or theme (for example 'auth' or 'checkout').",
    outcome: 'Adding labels restores up to 8 label points.',
  }),
  LABEL_CASE: ({ labels }) => ({
    problem: `Labels use inconsistent casing or spaces (${labels}) — filters treat them as different labels.`,
    how: "Rename the labels to lowercase-hyphen form (for example 'Auth' → 'auth', 'login page' → 'login-page'). The one-click fix does this automatically.",
    outcome: 'Consistent labels restore up to 4 label points. One-click fix available.',
  }),
  DUPLICATE_LABELS: ({ labels }) => ({
    problem: `Duplicate labels (case-insensitive): ${labels} — the same label appears twice under different casing.`,
    how: 'Remove the duplicates so each label appears once, in lowercase-hyphen form. The one-click fix does this automatically.',
    outcome: 'De-duplicated labels restore up to 3 label points. One-click fix available.',
  }),
  NO_COMPONENT: () => ({
    problem: 'No component set — ownership by area is unclear.',
    how: 'Set the Component field to the part of the product this issue belongs to.',
    outcome: 'A component restores up to 3 label points.',
  }),
  STALE_30D: ({ ageDays }) => ({
    problem: `Open issue untouched for ${ageDays} days — it may be forgotten or no longer relevant.`,
    how: 'Open the issue and either update it (comment with the current status), assign it, or close it if it is no longer needed.',
    outcome: 'Updating or closing the issue restores up to 5 freshness points.',
  }),
  STALE_90D: ({ ageDays }) => ({
    problem: `Open issue untouched for ${ageDays} days — probably stale or forgotten.`,
    how: 'Open the issue and either update it (comment with the current status and next step) or close it if it is no longer needed.',
    outcome: 'Updating or closing the issue restores up to 10 freshness points.',
  }),
  SUBTASK_NO_PARENT: () => ({
    problem: 'Sub-task has no parent issue — it floats outside any parent issue\u2019s plan.',
    how: 'Link the sub-task to its parent issue using the Parent field.',
    outcome: 'A parent restores up to 5 linkage points.',
  }),
  NO_LINKS: () => ({
    problem: 'No linked issues — no traceable context (blocks, relates to, duplicates).',
    how: 'Link the issue to related work with the Link action (for example "relates to" the epic or "is blocked by" the blocker).',
    outcome: 'Adding a link restores up to 3 linkage points.',
  }),
};

/** Three-part fix guidance for a finding code, or null for unknown codes. */
export function guidanceFor(code, ctx = {}) {
  const build = GUIDANCE_BUILDERS[code];
  return build ? build(ctx) : null;
}

// ------------------------------------------------------------- fix priority
// P0 = blocks triage (BLOCKED verdict or score under 40), P1 = needs work,
// P2 = minor issues only (a READY issue's info-level findings).
export function severityFor(score, verdict) {
  if (verdict === 'BLOCKED' || score < 40) return 'P0';
  if (verdict === 'NEEDS_WORK') return 'P1';
  return 'P2';
}

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 };

// ------------------------------------------------------------- single issue
export function scoreIssue(issue, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const findings = [];
  const dim = {
    completeness: 30,
    ownership: 20,
    planning: 15,
    taxonomy: 15,
    freshness: 10,
    linkage: 10,
  };
  const dock = (dimension, points, finding) => {
    dim[dimension] = Math.max(0, dim[dimension] - points);
    if (finding) {
      // Attach the three-part fix guidance (problem / how / outcome) to
      // every finding; `guidanceCtx` only carries the dynamic values.
      const { guidanceCtx, ...rest } = finding;
      findings.push({
        dimension,
        ...rest,
        guidance: guidanceFor(finding.code, guidanceCtx || {}),
      });
    }
  };

  const summary = (issue.summary || '').trim();
  const descLen = plainTextLength(issue.description);
  const descText =
    typeof issue.description === 'string' ? issue.description : '';
  const type = (issue.issueType || 'Task').toLowerCase();
  const isBug = type.includes('bug');

  // ---- Completeness (30)
  if (!summary) {
    dock('completeness', 15, {
      code: 'NO_SUMMARY', severity: 'critical',
      message: 'Issue has no summary.',
      fix: null,
    });
  } else if (summary.length < 10) {
    dock('completeness', 8, {
      code: 'SUMMARY_TOO_SHORT', severity: 'warning',
      message: `Summary is only ${summary.length} characters — too vague to triage.`,
      guidanceCtx: { summaryLength: summary.length },
      fix: null,
    });
  }
  if (descLen === 0) {
    dock('completeness', 12, {
      code: 'NO_DESCRIPTION', severity: 'critical',
      message: 'No description. Triage cannot tell what is wanted.',
      fix: null,
    });
  } else if (descLen < 40) {
    dock('completeness', 6, {
      code: 'DESCRIPTION_TOO_SHORT', severity: 'warning',
      message: `Description is only ${descLen} characters.`,
      guidanceCtx: { descLength: descLen },
      fix: null,
    });
  }
  if (isBug && descLen > 0) {
    const hasRepro = hasWord(descText, ['step', 'repro', 'expected', 'actual', 'to reproduce']);
    if (!hasRepro) {
      dock('completeness', 3, {
        code: 'BUG_NO_REPRO_STEPS', severity: 'warning',
        message: 'Bug has no reproduction steps or expected/actual behaviour.',
        fix: null,
      });
    }
  }

  // ---- Ownership (20)
  if (!issue.assignee) {
    dock('ownership', 12, {
      code: 'NO_ASSIGNEE', severity: 'critical',
      message: 'No assignee — nobody owns this issue.',
      fix: null,
    });
  }
  if (!issue.reporter) {
    dock('ownership', 8, {
      code: 'NO_REPORTER', severity: 'warning',
      message: 'No reporter recorded.',
      fix: null,
    });
  }

  // ---- Planning (15)
  if (!issue.priority) {
    dock('planning', 8, {
      code: 'NO_PRIORITY', severity: 'warning',
      message: 'No priority set — triage cannot rank this issue.',
      fix: { type: 'set-priority', priority: 'Medium' },
    });
  }
  if ((type.includes('story') || type.includes('task')) && issue.estimate == null) {
    dock('planning', 4, {
      code: 'NO_ESTIMATE', severity: 'info',
      message: 'No story-point estimate, so sprint planning cannot size this work.',
      fix: null,
    });
  }
  if (!issue.duedate && issue.status && !/done|closed|resolved/i.test(issue.status)) {
    dock('planning', 3, {
      code: 'NO_DUE_DATE', severity: 'info',
      message: 'No due date on an open issue.',
      fix: null,
    });
  }

  // ---- Taxonomy / labels (15)
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (labels.length === 0) {
    dock('taxonomy', 8, {
      code: 'NO_LABELS', severity: 'warning',
      message: 'No labels — the issue is invisible to label-based triage and reports.',
      fix: null,
    });
  } else {
    const badCase = labels.filter((l) => /[A-Z]/.test(l) || /\s/.test(l));
    if (badCase.length > 0) {
      dock('taxonomy', 4, {
        code: 'LABEL_CASE', severity: 'warning',
        message: `Labels use inconsistent casing/spaces (${badCase.join(', ')}). Use lowercase-hyphen labels.`,
        guidanceCtx: { labels: badCase.join(', ') },
        fix: { type: 'normalize-labels' },
      });
    }
    const dupes = labels.map((l) => l.toLowerCase()).filter((l, i, a) => a.indexOf(l) !== i);
    if (dupes.length > 0) {
      dock('taxonomy', 3, {
        code: 'DUPLICATE_LABELS', severity: 'info',
        message: `Duplicate labels (case-insensitive): ${[...new Set(dupes)].join(', ')}.`,
        guidanceCtx: { labels: [...new Set(dupes)].join(', ') },
        fix: { type: 'normalize-labels' },
      });
    }
  }
  const components = Array.isArray(issue.components) ? issue.components : [];
  if (components.length === 0) {
    dock('taxonomy', 3, {
      code: 'NO_COMPONENT', severity: 'info',
      message: 'No component set — ownership by area is unclear.',
      fix: null,
    });
  }

  // ---- Freshness (10)
  const ageDays = daysBetween(issue.updated, now);
  const open = issue.status ? !/done|closed|resolved/i.test(issue.status) : true;
  if (open && ageDays != null && ageDays > 90) {
    dock('freshness', 10, {
      code: 'STALE_90D', severity: 'critical',
      message: `Open issue untouched for ${Math.floor(ageDays)} days — probably stale or forgotten.`,
      guidanceCtx: { ageDays: Math.floor(ageDays) },
      fix: null,
    });
  } else if (open && ageDays != null && ageDays > 30) {
    dock('freshness', 5, {
      code: 'STALE_30D', severity: 'warning',
      message: `Open issue untouched for ${Math.floor(ageDays)} days.`,
      guidanceCtx: { ageDays: Math.floor(ageDays) },
      fix: null,
    });
  }

  // ---- Linkage (10)
  const links = Array.isArray(issue.linkedIssueKeys) ? issue.linkedIssueKeys : [];
  if (!issue.parentKey && type.includes('sub')) {
    dock('linkage', 5, {
      code: 'SUBTASK_NO_PARENT', severity: 'warning',
      message: 'Sub-task has no parent issue.',
      fix: null,
    });
  }
  if (links.length === 0 && !type.includes('sub')) {
    dock('linkage', 3, {
      code: 'NO_LINKS', severity: 'info',
      message: 'No linked issues — no traceable context (blocks / relates to / duplicates).',
      fix: null,
    });
  }

  const score = Object.values(dim).reduce((a, b) => a + b, 0);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const verdict = score >= 70 && critical === 0 ? 'READY' : score >= 50 ? 'NEEDS_WORK' : 'BLOCKED';

  return {
    key: issue.key || '(no key)',
    score,
    grade,
    verdict,
    dimensions: dim,
    criticalCount: critical,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings: findings.sort((a, b) =>
      ({ critical: 0, warning: 1, info: 2 })[a.severity] -
      ({ critical: 0, warning: 1, info: 2 })[b.severity]),
  };
}

// ------------------------------------------------------------- duplicates
// Word-level Jaccard similarity on BOTH the title and the full text
// (summary + description), taking the higher of the two: a reworded
// description still matches on the title, and a reworded title still
// matches on the body. A pair is a *likely duplicate* only at >= 0.7 —
// high enough that merely "about the same area" (0.3–0.6) is reported
// as similar, not as a duplicate.
export function findDuplicates(issues, opts = {}) {
  const threshold = opts.threshold ?? 0.7;
  const similarThreshold = opts.similarThreshold ?? 0.5;
  const pairs = [];
  const tokenCache = new Map();
  const tokensOf = (issue) => {
    if (!tokenCache.has(issue.key)) {
      tokenCache.set(
        issue.key,
        tokenize(`${issue.summary || ''} ${typeof issue.description === 'string' ? issue.description : ''}`)
      );
    }
    return tokenCache.get(issue.key);
  };
  for (let i = 0; i < issues.length; i++) {
    for (let j = i + 1; j < issues.length; j++) {
      const titleSim = jaccard(tokenize(issues[i].summary), tokenize(issues[j].summary));
      const textSim = jaccard(tokensOf(issues[i]), tokensOf(issues[j]));
      const sim = Math.max(titleSim, textSim);
      if (sim >= similarThreshold) {
        pairs.push({
          a: issues[i].key, b: issues[j].key,
          similarity: Math.round(sim * 100) / 100,
          titleSimilarity: Math.round(titleSim * 100) / 100,
          likelyDuplicate: sim >= threshold,
        });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

// ------------------------------------------------------------- project roll-up
export function scoreProject(issues, opts = {}) {
  const audits = issues.map((issue) => scoreIssue(issue, opts));
  const n = audits.length;
  const avg = n === 0 ? 0 : Math.round(audits.reduce((s, a) => s + a.score, 0) / n);
  const byGrade = { A: 0, B: 0, C: 0, D: 0 };
  audits.forEach((a) => { byGrade[a.grade]++; });
  const byVerdict = { READY: 0, NEEDS_WORK: 0, BLOCKED: 0 };
  audits.forEach((a) => { byVerdict[a.verdict]++; });
  const findingCounts = {};
  audits.forEach((a) => a.findings.forEach((f) => {
    findingCounts[f.code] = (findingCounts[f.code] || 0) + 1;
  }));
  const topProblems = Object.entries(findingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));
  const duplicates = findDuplicates(issues, opts);
  const fixable = audits.reduce(
    (s, a) => s + a.findings.filter((f) => f.fix).length, 0);
  // Fix priority queue: only issues that have findings, P0 first, then P1,
  // then P2, lowest score first within each tier. Top 5.
  const priorityQueue = audits
    .filter((a) => a.findings.length > 0)
    .map((a) => ({
      key: a.key,
      score: a.score,
      grade: a.grade,
      verdict: a.verdict,
      severity: severityFor(a.score, a.verdict),
      topFinding: a.findings[0]?.message || 'No findings',
      topGuidance: a.findings[0]?.guidance || null,
    }))
    .sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.score - b.score)
    .slice(0, 5);
  return {
    total: n,
    averageScore: avg,
    grade: avg >= 85 ? 'A' : avg >= 70 ? 'B' : avg >= 50 ? 'C' : 'D',
    byGrade,
    byVerdict,
    topProblems,
    duplicates,
    likelyDuplicates: duplicates.filter((d) => d.likelyDuplicate).length,
    fixableFindings: fixable,
    priorityQueue,
    worst: [...audits].sort((a, b) => a.score - b.score).slice(0, 5),
    audits,
  };
}
