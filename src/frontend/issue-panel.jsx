import * as ForgeReactModule from '@forge/react';
import {
  Box, Button, Heading, Lozenge, SectionMessage, Stack, Text,
  useProductContext,
} from '@forge/react';
// Namespace import on purpose: the deployed bundle crashed on default
// imports of CJS Forge packages ("out_namespaceObject is not a
// constructor"), so take the reconciler off the namespace's .default.
const ForgeReconciler = ForgeReactModule.default;
// @forge/react does not export invoke; it lives in @forge/bridge (CJS),
// so take it off the namespace object (same pattern as ForgeReconciler).
import * as ForgeBridgeModule from '@forge/bridge';
const invoke = ForgeBridgeModule.invoke;
import React, { useEffect, useState } from 'react';

function severityAppearance(s) {
  return s === 'critical' ? 'removed' : s === 'warning' ? 'inprogress' : 'default';
}

const App = () => {
  const context = useProductContext();
  // useProductContext() is empty on first render (bridge handshake still
  // pending) and fills in later; read the key from every known path.
  const issueKey = context?.extension?.issue?.key || context?.extension?.issueKey || context?.platformContext?.issueKey || '';
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fixNote, setFixNote] = useState(null);

  const load = async () => {
    if (!issueKey) { setError('No issue key found in this context.'); return; }
    setLoading(true); setError(null); setFixNote(null);
    try { setAudit(await invoke('getIssueAudit', { issueKey })); }
    catch (e) { setError(String(e)); }
    setLoading(false);
  };

  const applyFix = async (fixType) => {
    setLoading(true); setFixNote(null);
    try {
      const res = await invoke('applyFix', { issueKey, fixType });
      setFixNote(res.applied.length > 0 ? `Applied: ${res.applied.join('; ')}` : 'Nothing to fix for that type.');
      setAudit(res.after);
    } catch (e) { setError(String(e)); }
    setLoading(false);
  };

  // Do not audit on mount: on first render the context is still empty and
  // issueKey is ''. Wait until the key arrives, then audit once.
  useEffect(() => { if (issueKey) load(); }, [issueKey]);

  return (
    <Stack space="space.200">
      <Heading size="medium">IssueReady — {issueKey || 'issue audit'}</Heading>
      {error && (
        <SectionMessage title="Could not audit this issue" appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {fixNote && (
        <SectionMessage title="Fix applied" appearance="success">
          <Text>{fixNote}</Text>
        </SectionMessage>
      )}
      {audit && (
        <Stack space="space.200">
          <Text>
            Score: {audit.score}/100 (grade {audit.grade})
          </Text>
          <Lozenge
            appearance={audit.verdict === 'READY' ? 'success' : audit.verdict === 'NEEDS_WORK' ? 'inprogress' : 'removed'}
            text={audit.verdict}
          />
          <Text>
            Completeness {audit.dimensions.completeness}/30 · Ownership{' '}
            {audit.dimensions.ownership}/20 · Planning {audit.dimensions.planning}/15 ·{' '}
            Labels {audit.dimensions.taxonomy}/15 · Freshness {audit.dimensions.freshness}/10 ·{' '}
            Linkage {audit.dimensions.linkage}/10
          </Text>
          <Heading size="small">Failed checks</Heading>
          {audit.findings.length === 0 && <Text>No findings — this issue is ready for triage.</Text>}
          <Stack>
            {audit.findings.map((f) => (
              <Box key={f.code}>
                <Lozenge appearance={severityAppearance(f.severity)} text={f.severity} />
                <Text>{f.code}: {f.message}</Text>
                {f.guidance && (
                  <Stack>
                    <Text>How to fix: {f.guidance.how}</Text>
                    <Text>After the fix: {f.guidance.outcome}</Text>
                  </Stack>
                )}
                {f.fix && (
                  <Button appearance="default" onClick={() => applyFix(f.fix.type)} isDisabled={loading}>
                    Fix: {f.fix.type === 'set-priority' ? 'set priority to Medium' : 'normalise labels'}
                  </Button>
                )}
              </Box>
            ))}
          </Stack>
          <Button appearance="default" onClick={() => applyFix('post-audit-comment')} isDisabled={loading}>
            Post audit summary as a comment
          </Button>
          <Button appearance="default" onClick={load} isDisabled={loading}>
            Re-audit
          </Button>
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(<App />);
