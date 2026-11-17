import * as ForgeReactModule from '@forge/react';
import {
  Box, Button, Heading, Lozenge, SectionMessage, Stack, Text,
  useProductContext,
} from '@forge/react';
// Namespace import on purpose: the deployed bundle crashed on default
// imports of CJS Forge packages ("out_namespaceObject is not a
// constructor"), so take the reconciler off the namespace's .default.
const ForgeReconciler = ForgeReactModule.default;
// @forge/bridge is CJS and @forge/react does not re-export invoke at all,
// so take both off the namespace object (same pattern as ForgeReconciler).
import * as ForgeBridgeModule from '@forge/bridge';
const invoke = ForgeBridgeModule.invoke;
const router = ForgeBridgeModule.router;
import React, { useEffect, useState } from 'react';

function verdictAppearance(v) {
  // Lozenge appearances in @forge/react: default | success | inprogress |
  // new | moved | removed. No 'warning'/'danger' — map accordingly.
  return v === 'READY' ? 'success' : v === 'NEEDS_WORK' ? 'inprogress' : 'removed';
}

function TrendView({ history }) {
  if (!history || history.length === 0) {
    return (
      <Text>
        No audit history yet — run an audit and come back; the weekly Monday
        audit keeps this trend growing automatically.
      </Text>
    );
  }
  return (
    <Stack>
      {history.slice(-5).map((s, i, arr) => {
        const prev = arr[i - 1];
        const delta = prev ? s.averageScore - prev.averageScore : null;
        const date = new Date(s.at).toLocaleDateString();
        return (
          <Text key={`${s.at}-${i}`}>
            {date}: {s.averageScore}/100 ({s.total} issues, READY {s.byVerdict.READY}
            {' · '}NEEDS_WORK {s.byVerdict.NEEDS_WORK}{' · '}BLOCKED {s.byVerdict.BLOCKED})
            {delta === null ? '' : delta > 0 ? ` ▲ +${delta}` : delta < 0 ? ` ▼ ${delta}` : ' — no change'}
          </Text>
        );
      })}
    </Stack>
  );
}

function AuditView({ report, source, history }) {
  return (
    <Stack space="space.200">
      <Heading size="medium">
        Data quality: {report.averageScore}/100 (grade {report.grade})
      </Heading>
      <Text>
        {source === 'demo'
          ? 'Demo data — 13 synthetic issues, so you can try everything without touching real Jira data.'
          : 'Live data from this Jira project.'}
      </Text>
      <Stack>
        <Text>READY: {report.byVerdict.READY} · NEEDS_WORK: {report.byVerdict.NEEDS_WORK} · BLOCKED: {report.byVerdict.BLOCKED}</Text>
        <Text>Grades — A: {report.byGrade.A} · B: {report.byGrade.B} · C: {report.byGrade.C} · D: {report.byGrade.D}</Text>
        <Text>Fixable with one click: {report.fixableFindings} findings</Text>
        <Text>Likely duplicates: {report.likelyDuplicates}</Text>
      </Stack>
      <Heading size="small">Fix first — top 5 priority issues</Heading>
      {report.priorityQueue && report.priorityQueue.length > 0 ? (
        <Stack>
          {report.priorityQueue.map((item, i) => (
            <Box key={item.key}>
              <Text>
                {i + 1}. [{item.severity}] {item.key}: {item.score}/100 ({item.grade}, {item.verdict})
              </Text>
              <Lozenge appearance={verdictAppearance(item.verdict)} text={item.verdict} />
              <Text>{item.topFinding}</Text>
              {item.topGuidance && <Text>How to fix: {item.topGuidance.how}</Text>}
            </Box>
          ))}
        </Stack>
      ) : (
        <Text>No issues need fixing — every audited issue is clean.</Text>
      )}
      <Heading size="small">Audit history — average score over time</Heading>
      {source === 'demo' ? (
        <Text>
          Demo mode does not record history. Audit a live project and this
          section shows the trend, refreshed by the automatic Monday audit.
        </Text>
      ) : (
        <TrendView history={history} />
      )}
      <Heading size="small">Top recurring problems</Heading>
      <Stack>
        {report.topProblems.map((p) => (
          <Text key={p.code}>• {p.code}: {p.count} issue(s)</Text>
        ))}
      </Stack>
      <Heading size="small">Worst issues</Heading>
      <Stack>
        {report.worst.map((w) => (
          <Box key={w.key}>
            <Text>
              {w.key}: {w.score}/100 ({w.grade})
            </Text>
            <Lozenge appearance={verdictAppearance(w.verdict)} text={w.verdict} />
            <Text>{w.findings[0] ? w.findings[0].message : 'No findings'}</Text>
          </Box>
        ))}
      </Stack>
      {report.duplicates.length > 0 && (
        <SectionMessage title="Possible duplicates" appearance="warning">
          <Stack>
            {report.duplicates.map((d) => (
              <Text key={`${d.a}-${d.b}`}>
                {d.a} ~ {d.b} — similarity {d.similarity}
                {d.likelyDuplicate ? ' (likely duplicate)' : ' (similar)'}
              </Text>
            ))}
          </Stack>
        </SectionMessage>
      )}
    </Stack>
  );
}

const App = () => {
  const context = useProductContext();
  const projectKey = context?.platformContext?.projectKey || context?.extension?.project?.key || '';
  const [report, setReport] = useState(null);
  const [source, setSource] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fixNote, setFixNote] = useState(null);

  const loadLive = async () => {
    if (!projectKey) { setError('No project key found in this context.'); return; }
    setLoading(true); setError(null); setFixNote(null);
    try {
      setReport(await invoke('getProjectAudit', { projectKey }));
      setHistory((await invoke('getAuditHistory', { projectKey })).history);
      setSource('live');
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  const loadDemo = async () => {
    setLoading(true); setError(null); setFixNote(null);
    try {
      setReport(await invoke('getDemoAudit', {}));
      setHistory(null);
      setSource('demo');
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  const fixAll = async () => {
    if (!projectKey || source !== 'live') return;
    setLoading(true); setError(null); setFixNote(null);
    try {
      const res = await invoke('applyFixAll', { projectKey });
      setFixNote(`Fixed ${res.fixedCount} of ${res.total} issues, skipped ${res.skippedCount} with nothing fixable. Re-auditing…`);
      setReport(await invoke('getProjectAudit', { projectKey }));
      setHistory((await invoke('getAuditHistory', { projectKey })).history);
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  const exportCsv = async () => {
    if (!projectKey || source !== 'live') return;
    setLoading(true); setError(null);
    try {
      const { url } = await invoke('getCsvExportUrl', { projectKey });
      await router.open(url);
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  const exportMd = async () => {
    if (!projectKey || source !== 'live') return;
    setLoading(true); setError(null);
    try {
      const { url } = await invoke('getMdExportUrl', { projectKey });
      await router.open(url);
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  useEffect(() => { loadDemo(); }, []);

  return (
    <Stack space="space.200">
      <Heading size="large">IssueReady — Jira Data Quality</Heading>
      <Text>
        Triage is only as good as the data it reads. IssueReady scores every
        issue 0–100 on completeness, ownership, planning, labels, freshness
        and linkage — then shows you the debt and fixes the fixable.
      </Text>
      <Stack>
        <Button appearance="primary" onClick={loadLive} isDisabled={loading || !projectKey}>
          {loading ? 'Auditing…' : 'Audit this project'}
        </Button>
        <Button appearance="default" onClick={loadDemo} isDisabled={loading}>
          Load demo data
        </Button>
        <Button appearance="default" onClick={fixAll} isDisabled={loading || source !== 'live' || !report}>
          Fix all fixable issues
        </Button>
        <Button appearance="default" onClick={exportCsv} isDisabled={loading || source !== 'live' || !report}>
          Export CSV
        </Button>
        <Button appearance="default" onClick={exportMd} isDisabled={loading || source !== 'live' || !report}>
          Export Markdown report
        </Button>
      </Stack>
      {error && (
        <SectionMessage title="Could not audit" appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {fixNote && (
        <SectionMessage title="Bulk fix finished" appearance="success">
          <Text>{fixNote}</Text>
        </SectionMessage>
      )}
      {report && <AuditView report={report} source={source} history={history} />}
    </Stack>
  );
};

ForgeReconciler.render(<App />);
