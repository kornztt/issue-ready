import { readFileSync } from 'node:fs';
import { scoreProject } from './src/lib/scoring.js';

// Scores the demo data with a fixed "now" so output is reproducible.
// Before/after: v1 (demo/demo-issues-v1.json, the original messy set) vs
// v2 (demo/demo-issues.json, the same 13 issues after the team fixed the
// fields IssueReady flagged — assignees, labels, due dates, links, and a
// real summary/description on the worst issue). The scoring engine is
// untouched; only the issue data changed.
// Usage: node demo-run.js   (from issue-ready/)
const NOW = '2026-11-17T00:00:00.000Z';
const load = (file) =>
  JSON.parse(readFileSync(new URL(`../demo/${file}`, import.meta.url), 'utf8'));

const before = scoreProject(load('demo-issues-v1.json'), { now: NOW });
const after = scoreProject(load('demo-issues.json'), { now: NOW });

const verdictLine = (r) =>
  `READY ${r.byVerdict.READY}, NEEDS_WORK ${r.byVerdict.NEEDS_WORK}, BLOCKED ${r.byVerdict.BLOCKED}`;
console.log('Before/after — same 13 issues, fields fixed, engine untouched:');
console.log(`  v1 (original): average ${before.averageScore}/100 (grade ${before.grade}) — ${verdictLine(before)}`);
console.log(`  v2 (fixed up): average ${after.averageScore}/100 (grade ${after.grade}) — ${verdictLine(after)}`);
console.log(`  delta: +${after.averageScore - before.averageScore} points`);
console.log('');
console.log(`Project: ${after.total} issues, average ${after.averageScore}/100 (grade ${after.grade})`);
console.log(`Verdicts: ${verdictLine(after)}`);
console.log(`Grades: ${JSON.stringify(after.byGrade)}`);
console.log(`Fixable findings (one-click fixes available): ${after.fixableFindings}`);
console.log(`Likely duplicates: ${after.likelyDuplicates}`);
for (const d of after.duplicates) {
  console.log(`  duplicate? ${d.a} ~ ${d.b} similarity=${d.similarity} likely=${d.likelyDuplicate}`);
}
console.log('Top problems:');
for (const p of after.topProblems) console.log(`  ${p.code}: ${p.count} issues`);
console.log('Worst issues:');
for (const w of after.worst) {
  console.log(`  ${w.key}: ${w.score} (${w.grade}, ${w.verdict}) — ${w.findings.map((f) => f.code).join(', ')}`);
}
console.log('\nPer-issue scores:');
for (const a of after.audits) console.log(`  ${a.key}: ${a.score} ${a.grade} ${a.verdict}`);
console.log('\nStill imperfect (kept on purpose, so the tool can show it finds problems):');
for (const a of after.audits.filter((x) => x.verdict !== 'READY')) {
  console.log(`  ${a.key}: ${a.score} ${a.verdict} — ${a.findings.map((f) => f.code).join(', ')}`);
}
