/**
 * IssueReady CSV export — PURE module (no Forge imports, unit-testable).
 *
 * One row per audited issue: key, score, grade, verdict, top finding.
 * RFC 4180 quoting: fields containing a comma, quote or newline are
 * double-quoted with inner quotes doubled. A UTF-8 BOM is prepended so
 * Excel opens the file with the right encoding.
 */

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report) {
  const header = ['Issue', 'Score', 'Grade', 'Verdict', 'Top finding'];
  const lines = [header.map(csvCell).join(',')];
  for (const a of report?.audits || []) {
    lines.push([
      a.key,
      a.score,
      a.grade,
      a.verdict,
      a.findings?.[0]?.message || 'No findings',
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
