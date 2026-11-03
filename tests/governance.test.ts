import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ProtocolBundle } from '../shared/types.ts';
import { client, signIn } from './helpers.ts';

// End-to-end acceptance scenarios for USDM mapping and data governance (synthetic data only), run as the
// seeded role accounts so permissions are exercised at the API level.

const dir = mkdtempSync(join(tmpdir(), 'protocoliq-gov-test-'));
process.env.PROTOCOLIQ_DB = join(dir, 'test.db');
process.env.PROTOCOLIQ_NO_LISTEN = '1';
process.env.PROTOCOLIQ_DEMO = '1';

let base = '';
let close: () => void = () => {};
type Client = ReturnType<typeof client>;
let admin: Client, steward: Client, author: Client, reviewer: Client, viewer: Client;

before(async () => {
  const { app } = await import('../server/index.ts');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => server.close();
  [admin, steward, author, reviewer, viewer] = await Promise.all(['admin', 'steward', 'author', 'reviewer', 'viewer'].map(async (u) => client(base, await signIn(base, u))));
});

after(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const state: Record<string, any> = {};

const DOC = `Protocol Title: SYNTHETIC TEST - A Phase 3 Study of TST-9 in Adults with Hypertension
Protocol Number: TST-9-301
Sponsor: Test Sponsor Ltd (fictional)
Version: 1.0

3. TRIAL OBJECTIVES AND PURPOSE
3.1 Objectives
Primary objective: To evaluate the change in systolic blood pressure at Week 12.

5. SELECTION AND WITHDRAWAL OF SUBJECTS
5.1 Inclusion Criteria
1. Adults aged 18 to 75 years.
2. Signed informed consent.
5.2 Exclusion Criteria
1. Pregnancy or breastfeeding.
`;

test('access control: unauthenticated requests are rejected and roles are enforced by the API', async () => {
  assert.equal((await fetch(`${base}/protocols`)).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-password' }) });
  assert.equal(bad.status, 401);
  assert.equal((await viewer.send('POST', '/protocols', { title: 'Not allowed' })).status, 403);
  assert.equal((await author.send('GET', '/governance/audit')).status, 403);
  assert.equal((await author.send('POST', '/usdm/mappings', {})).status, 403);
  const cross = await fetch(`${base}/protocols`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: '' }, body: '{}' });
  assert.ok([401, 403].includes(cross.status));
});

test('1. create a protocol with the Protocol Builder (lineage: builder, pending review)', async () => {
  const { id } = await author.post('/protocols', { title: 'SYNTHETIC Builder protocol', protocolNumber: 'BLD-001', sponsorName: 'Builder Sponsor (fictional)', phase: 'Phase 2' });
  const b: ProtocolBundle = await author.get(`/protocols/${id}`);
  await author.post(`/protocols/${id}/save`, { objectives: [{ id: crypto.randomUUID(), code: 'PO1', category: 'Primary', description: 'To assess a synthetic outcome.' }] });
  const lineage = await viewer.get(`/governance/protocols/${id}/lineage`);
  assert.ok(lineage.length > 0);
  assert.ok(lineage.every((l: any) => l.sourceType === 'builder'));
  assert.ok(lineage.some((l: any) => l.elementType === 'objective' && l.reviewStatus === 'Pending' && l.createdBy === 'usr-author'));
  state.builder = { protocolId: id, studyId: b.study.id };
});

test('2. upload a protocol with Protocol Digitisation (lineage: document, section and source text)', async () => {
  const res = await fetch(`${base}/digitisation/upload?filename=synthetic-protocol.txt`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', cookie: await signIn(base, 'author') },
    body: DOC,
  });
  assert.equal(res.status, 201);
  const { protocolId } = await res.json();
  const lineage = await viewer.get(`/governance/protocols/${protocolId}/lineage`);
  assert.ok(lineage.every((l: any) => l.sourceType === 'digitisation'));
  const criterion = lineage.find((l: any) => l.elementType === 'criterion');
  assert.ok(criterion, 'criteria were extracted');
  assert.ok(criterion.sourceDocumentId && criterion.sourceText && criterion.sourceSection, 'source location recorded');
  state.digitised = { protocolId, criterionId: criterion.elementId, studyId: criterion.studyId };
});

test('3. both workflows write to the shared structured study database', async () => {
  const protocols = await viewer.get('/protocols');
  const sources = new Set(protocols.map((p: any) => p.source));
  assert.ok(sources.has('builder') && sources.has('digitisation'));
  const studies = await viewer.get('/studies');
  for (const s of [state.builder.studyId, state.digitised.studyId]) assert.ok(studies.some((x: any) => x.id === s));
});

test('4-6. map to USDM 4.0.0, identify unmapped fields and validate against the official schema', async () => {
  const { releases } = await viewer.get('/usdm/releases');
  const selected = releases.find((r: any) => r.isSelected);
  assert.equal(selected.version, '4.0.0');

  // Builder protocol with gaps: the run is stored, invalid and lists what is missing.
  const gap = await author.post(`/usdm/map-study/${state.builder.studyId}`, {});
  assert.equal(gap.status, 'invalid');
  assert.ok(gap.report.counts.schemaErrors > 0, 'missing required data surfaces as schema errors');
  assert.match(gap.report.conformance.label, /not|invalid|fail/i);

  // Synthetic example study (seeded with lineage and demo manual values).
  const example = (await viewer.get('/protocols')).find((p: any) => p.protocolNumber === 'EXA-101-201');
  state.example = { protocolId: example.id, studyId: example.studyId };
  const run = await author.post(`/usdm/map-study/${example.studyId}`, {});
  assert.equal(run.status, 'valid', JSON.stringify(run.report.validation.schemaErrors.slice(0, 3)));
  const unmapped = run.report.records.flatMap((r: any) => r.fields.filter((f: any) => ['unsupported', 'needs-config', 'no-equivalent', 'empty', 'unconverted', 'terminology-review'].includes(f.outcome)));
  assert.ok(run.report.counts.fieldsUnmapped > 0 && unmapped.length > 0, 'unmapped fields are reported, not forced');
  assert.ok(unmapped.every((f: any) => f.message), 'each unmapped field records a reason');

  const v = await author.post(`/usdm/validate/${example.studyId}`, { runId: run.id });
  assert.equal(v.validation.schemaValid, true);
  assert.equal(v.validation.referencesValid, true);
  assert.match(v.conformance.label, /schema-valid/);
  assert.doesNotMatch(v.conformance.label, /compliant/i);
  state.run = run;

  // Mapping rule management: a field without equivalent needs a reason; viewers cannot edit.
  const bad = await admin.send('POST', '/usdm/mappings', { sourceEntity: 'study', sourceField: 'therapeuticArea', transformationType: 'unsupported', status: 'Not Mapped' });
  assert.equal(bad.status, 400);
  const created = await admin.post('/usdm/mappings', { sourceEntity: 'study', sourceField: 'therapeuticArea', transformationType: 'unsupported', status: 'Not Mapped', reason: 'No USDM 4.0.0 property for therapeutic area (test)' });
  assert.equal(created.status, 'Not Mapped');
  assert.equal((await viewer.send('PUT', `/usdm/mappings/${created.id}`, { reason: 'x' })).status, 403);
});

test('7-9. create a data quality issue, assign it to a data steward and resolve it', async () => {
  const { runs } = await author.post(`/governance/validate/${state.builder.studyId}`, {});
  assert.ok(runs[0].findings > 0 && runs[0].issues.opened > 0);
  assert.ok(typeof runs[0].score === 'number');
  const list = await viewer.get(`/governance/issues?studyId=${state.builder.studyId}&status=unresolved&pageSize=5`);
  assert.ok(list.total >= list.items.length && list.items.length > 0);
  assert.ok(list.items.length <= 5, 'paginated');

  const manual = await reviewer.post('/governance/issues', { studyId: state.builder.studyId, protocolId: state.builder.protocolId, severity: 'High', category: 'consistency', title: 'Synthetic manual issue', description: 'Raised in test' });
  assert.equal(manual.status, 'Open');
  assert.equal((await author.send('PUT', `/governance/issues/${manual.id}`, { assignedTo: 'usr-steward' })).status, 403, 'authors cannot assign');
  const assigned = await steward.put(`/governance/issues/${manual.id}`, { assignedTo: 'usr-steward', comment: 'Taking this one' });
  assert.equal(assigned.status, 'Assigned');
  assert.equal(assigned.assignedTo, 'usr-steward');
  assert.equal((await steward.send('PUT', `/governance/issues/${manual.id}`, { status: 'Resolved' })).status, 400, 'resolution required');
  const resolved = await steward.put(`/governance/issues/${manual.id}`, { status: 'Resolved', resolution: 'Corrected in source (synthetic)' });
  assert.equal(resolved.status, 'Resolved');

  // Exceptions need exception.approve and a reason.
  const other = list.items.find((i: any) => i.status !== 'Accepted Exception');
  assert.equal((await steward.send('PUT', `/governance/issues/${other.id}`, { status: 'Accepted Exception', exceptionReason: 'n/a' })).status, 403);
  assert.equal((await admin.send('PUT', `/governance/issues/${other.id}`, { status: 'Accepted Exception' })).status, 400);
  const waived = await admin.put(`/governance/issues/${other.id}`, { status: 'Accepted Exception', exceptionReason: 'Accepted for synthetic test study' });
  assert.equal(waived.status, 'Accepted Exception');
  assert.equal(waived.exceptionApprovedBy, 'usr-admin');
  const detail = await viewer.get(`/governance/issues/${manual.id}`);
  assert.ok(detail.comments.length >= 1 && detail.history.length >= 3);
});

test('10-11. change control: Final protocols are locked; change requests are validated, reviewed and approved or rejected', async () => {
  const pid = state.example.protocolId;
  assert.equal((await author.send('PATCH', `/protocols/${pid}/status`, { status: 'Final' })).status, 403, 'authors cannot approve');
  await reviewer.patch(`/protocols/${pid}/status`, { status: 'Final', reason: 'Approved for test' });
  const b: ProtocolBundle = await author.get(`/protocols/${pid}`);
  assert.equal(b.protocol.status, 'Final');
  const locked = await author.send('POST', `/protocols/${pid}/save`, { meta: { indication: 'changed' } });
  assert.equal(locked.status, 423, 'direct edits are blocked on Final protocols');

  const crit = b.criteria[0];
  const payload = { criteria: b.criteria.map((c) => (c.id === crit.id ? { ...c, text: `${c.text} (amended)` } : c)) };
  assert.equal((await author.send('POST', '/governance/change-requests', { protocolId: pid, title: 'Amend I1', payload })).status, 400, 'justification required');
  const cr = await author.post('/governance/change-requests', { protocolId: pid, title: 'Amend inclusion criterion', justification: 'Clarify wording (synthetic)', payload, submit: true });
  assert.equal(cr.status, 'Pending Review');
  assert.equal(cr.validation.newErrors.length, 0);
  assert.equal(cr.diff.elements.length, 1);
  assert.equal((await author.send('POST', `/governance/approve/${cr.id}`, {})).status, 403);
  const approved = await reviewer.post(`/governance/approve/${cr.id}`, { comment: 'Looks right' });
  assert.equal(approved.status, 'Approved');
  assert.ok(approved.resultingVersionId);
  const after: ProtocolBundle = await author.get(`/protocols/${pid}`);
  assert.match(after.criteria.find((c) => c.id === crit.id)!.text, /amended/);
  assert.equal(after.protocol.status, 'Final');
  state.crElement = crit.id;
  state.approvedVersion = approved.resultingVersionId;

  const cr2 = await author.post('/governance/change-requests', { protocolId: pid, title: 'Change indication', justification: 'Test rejection', payload: { meta: { indication: 'Something else' } }, submit: true });
  assert.equal((await reviewer.send('POST', `/governance/reject/${cr2.id}`, {})).status, 400, 'rejection comment required');
  const rejected = await reviewer.post(`/governance/reject/${cr2.id}`, { comment: 'Not supported by source data' });
  assert.equal(rejected.status, 'Rejected');
  assert.equal(((await author.get(`/protocols/${pid}`)) as ProtocolBundle).study.indication, b.study.indication, 'rejected change is not applied');
});

test('12. version history keeps approved versions immutable and shows the change', async () => {
  const { versions, changeRequests } = await viewer.get(`/governance/versions/${state.example.studyId}`);
  const approved = versions.filter((v: any) => v.approvalStatus === 'Approved');
  assert.ok(approved.length >= 2, 'Final approval + approved change request');
  const crVersion = versions.find((v: any) => v.id === state.approvedVersion);
  assert.equal(crVersion.authorId, 'usr-author');
  assert.equal(crVersion.approvedBy, 'usr-reviewer');
  assert.equal(crVersion.changeReason, 'Clarify wording (synthetic)');
  assert.ok(changeRequests.some((c: any) => c.status === 'Rejected' && c.decisionComment));
  const first = approved[approved.length - 1];
  const cmp = await viewer.get(`/governance/protocols/${state.example.protocolId}/compare?from=${first.id}&to=${state.approvedVersion}`);
  assert.ok(cmp.diff.elements.some((e: any) => e.id === state.crElement && e.change === 'modified'));
  assert.ok(cmp.mapping, 'mapping definitions are compared too');
  assert.equal((await admin.send('DELETE', `/protocols/${state.example.protocolId}`)).status, 409, 'protocols with approved versions cannot be deleted');
});

test('13. the audit trail records the whole process and is tamper-evident', async () => {
  const audit = await reviewer.get(`/governance/audit?studyId=${state.example.studyId}&pageSize=200`);
  const actions = new Set(audit.items.map((a: any) => a.action));
  for (const a of ['protocol.approved', 'change_request.created', 'change_request.submitted', 'change_request.approved', 'change_request.rejected', 'usdm.mapping.run', 'version.created'])
    assert.ok(actions.has(a), `audit has ${a}`);
  const logins = await admin.get('/governance/audit?action=auth.login&pageSize=5');
  assert.ok(logins.total >= 5);
  assert.deepEqual((await admin.get('/governance/audit/verify')).ok, true);
  assert.equal((await admin.send('DELETE', '/governance/audit')).status, 404, 'no route modifies audit records');
});

test('14. complete lineage of an element: source, versions, reviews and USDM mapping', async () => {
  const digitised = await viewer.get(`/governance/lineage/${state.digitised.criterionId}`);
  assert.equal(digitised.lineage.sourceType, 'digitisation');
  assert.ok(digitised.lineage.sourceDocumentName && digitised.lineage.sourceText);
  assert.ok(digitised.versions.length >= 1);
  const changed = await viewer.get(`/governance/lineage/${state.crElement}`);
  assert.ok(changed.versions.some((v: any) => v.changeRequestId), 'change request recorded on the element version');
  assert.equal(changed.lineage.reviewStatus, 'Approved');
  assert.ok(changed.usdm?.record, 'USDM entity recorded by the mapping run');
});

test('15. export the validated USDM representation (approved, current run only)', async () => {
  const { studyId } = state.example;
  // The approved change made the earlier run stale; exporting it is refused and recorded.
  const refused = await reviewer.send('GET', `/usdm/export/${studyId}?runId=${state.run.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.record.status, 'rejected');

  const run = await author.post(`/usdm/map-study/${studyId}`, {});
  assert.equal(run.status, 'valid');
  assert.equal((await author.send('POST', `/usdm/runs/${run.id}/review`, { decision: 'Approved' })).status, 403, 'creator cannot approve');
  await reviewer.post(`/usdm/runs/${run.id}/review`, { decision: 'Approved', comment: 'Reviewed mapping' });
  assert.equal((await viewer.send('GET', `/usdm/export/${studyId}`)).status, 403);
  const res = await reviewer.send('GET', `/usdm/export/${studyId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.usdmVersion, '4.0.0');
  assert.equal(res.body.study.instanceType, 'Study');
  assert.match(decodeURIComponent(res.headers.get('x-conformance')!), /schema-valid/);
  const history = await viewer.get(`/usdm/exports?studyId=${studyId}`);
  assert.ok(history.items.some((e: any) => e.status === 'exported') && history.items.some((e: any) => e.status === 'rejected'));
});

test('governance dashboard, owners and dictionary are computed from stored data', async () => {
  await steward.post('/governance/owners', { studyId: state.example.studyId, responsibility: 'Owner', userId: 'usr-author' });
  const d = await viewer.get('/governance/dashboard');
  assert.ok(d.totals.studies >= 3 && d.totals.exports >= 1 && d.totals.studiesWithOwner >= 1);
  assert.ok(d.studies.some((s: any) => s.mapping?.valid));
  const dict = await viewer.get('/governance/dictionary?q=phase');
  assert.ok(dict.some((e: any) => e.id === 'study.phase' && e.usdmMappings.length > 0));
  assert.equal((await steward.send('PUT', '/governance/dictionary/study.phase', { name: 'x', dataType: 'text' })).status, 403);
});
