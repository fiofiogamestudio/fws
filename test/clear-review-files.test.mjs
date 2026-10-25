import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { reviewSpace, formatReview } from '../skills/fw-clear/scripts/review-space.mjs';

const timestamp = '2026-10-25T02:00:00.000Z';
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '.';

// Independent per-file fixture construction: aggregate each child once after
// constructing all directories, rather than copying the analyzer's partition.
function snapshot(specs = { mixed: { 'duplicate.bin': 101, 'unique.cs': 17, 'changed.cs': 23, 'empty.txt': 0 }, 'mixed/child': { 'generated.bin': 47 } }) {
  const directories = new Map();
  const ensure = relativePath => {
    if (directories.has(relativePath)) return directories.get(relativePath);
    const node = { relativePath, parentRelativePath: relativePath === '.' ? null : parentOf(relativePath),
      logicalBytes: 0, files: 0, directBytes: 0, directFiles: 0,
      errorCount: 0, skippedCount: 0, directErrorCount: 0, directSkippedCount: 0,
      directGitMarkers: [], directFileEntries: [], children: [] };
    directories.set(relativePath, node);
    if (relativePath !== '.') ensure(parentOf(relativePath)).children.push(node);
    return node;
  };
  ensure('.');
  for (const [directory, files] of Object.entries(specs)) {
    const node = ensure(directory);
    node.directFileEntries = Object.entries(files).map(([name, logicalBytes]) => ({ name, logicalBytes, modifiedAt: timestamp }));
    node.directFiles = node.directFileEntries.length;
    node.directBytes = node.directFileEntries.reduce((sum, file) => sum + file.logicalBytes, 0);
  }
  const total = node => {
    node.logicalBytes = node.directBytes;
    node.files = node.directFiles;
    for (const child of node.children) { total(child); node.logicalBytes += child.logicalBytes; node.files += child.files; }
  };
  total(directories.get('.'));
  const root = directories.get('.');
  return { schemaVersion: 2, root: path.join(os.tmpdir(), 'fw-clear-file-review-synthetic'),
    finishedAt: timestamp, measurement: 'logical-file-lengths', inventoryComplete: true, fileDetailsEnabled: true,
    totals: { logicalBytes: root.logicalBytes, files: root.files }, errorCount: 0, skippedCount: 0,
    inventory: [...directories.values()].map(({ children, ...node }) => node) };
}

const nodeAt = (scan, relativePath) => scan.inventory.find(node => node.relativePath === relativePath);
const decision = (relativePath, disposition = 'conditional', scope = 'file') => ({ relativePath, scope, disposition,
  reason: 'Fixture content and consumer references were checked', evidence: ['fixture comparison and consumer manifest'],
  regenerate: 'Restore this exact file from the retained counterpart', prerequisites: ['Recheck counterpart and references'] });
const run = (scan, entries = [], options = {}) => reviewSpace(scan, { ...options, decisions: {
  schemaVersion: 1, root: scan.root, scanFinishedAt: scan.finishedAt, decisions: entries,
} });
const retiredFile = relativePath => ({ ...decision(relativePath, 'retired'), regenerate: undefined,
  retirement: { generatedBy: 'Completed capture worker', completionEvidence: ['Published final capture passed validation'],
    consumerAudit: 'Current playback uses the retained final capture; no consumer opens the old intermediate',
    preservedEvidence: ['Final capture, receipt and source archive'],
    impact: 'Retires old generated output without promising exact historical reconstruction' } });

function assertMeasuredExactlyOnce(scan, report, focus = '.') {
  const inFocus = value => focus === '.' || value === focus || value.startsWith(`${focus}/`);
  const sourceFiles = scan.inventory.filter(node => inFocus(node.relativePath)).flatMap(node => node.directFileEntries.map(file => ({
    directory: node.relativePath, relativePath: node.relativePath === '.' ? file.name : `${node.relativePath}/${file.name}`, ...file,
  })));
  for (const file of sourceFiles) {
    const owners = report.rows.filter(row => row.scope === 'file' ? row.relativePath === file.relativePath :
      row.scope === 'direct' ? row.relativePath === file.directory && !row.excludedFiles.includes(file.name) :
        row.relativePath === '.' || file.relativePath.startsWith(`${row.relativePath}/`));
    assert.equal(owners.length, 1, `${file.relativePath} must be counted once`);
  }
  assert.equal(report.logicalBytes, sourceFiles.reduce((sum, file) => sum + file.logicalBytes, 0));
  assert.equal(report.files, sourceFiles.length);
  assert.equal(report.rows.reduce((sum, row) => sum + row.logicalBytes, 0), report.logicalBytes);
  assert.equal(report.rows.reduce((sum, row) => sum + row.files, 0), report.files);
  assert.equal(Object.values(report.totals).reduce((sum, value) => sum + value.logicalBytes, 0), report.logicalBytes);
  assert.ok(report.rows.every(row => row.deletionApproved === false));
}

test('file decision separates duplicates while residual direct rows exclude exact bytes counts and names', () => {
  const scan = snapshot();
  const result = run(scan, [decision('mixed/duplicate.bin')]);
  const residual = result.rows.find(row => row.scope === 'direct' && row.relativePath === 'mixed');
  assert.equal(residual.logicalBytes, 40);
  assert.equal(residual.files, 3);
  assert.deepEqual(residual.excludedFiles, ['duplicate.bin']);
  assert.equal(residual.disposition, 'unreviewed');
  assert.equal(result.totals.conditional.logicalBytes, 101);
  assertMeasuredExactlyOnce(scan, result);
  assert.match(formatReview(result), /remaining immediate files.*excluding separately listed file rows/);
});

test('mixed keep conditional and regenerable files retain individual provenance and zero-length counts', () => {
  const scan = snapshot();
  const entries = [decision('mixed/duplicate.bin'), decision('mixed/unique.cs', 'keep'), decision('mixed/changed.cs', 'keep'),
    decision('mixed/empty.txt', 'keep'), decision('mixed/child/generated.bin', 'regenerable')];
  for (const chunkMiB of [0.000001, 1, 1024]) {
    const result = run(scan, entries, { chunkMiB });
    assertMeasuredExactlyOnce(scan, result);
    assert.equal(result.totals.keep.logicalBytes, 40);
    assert.equal(result.totals.keep.files, 3);
    assert.equal(result.totals.conditional.logicalBytes, 101);
    assert.equal(result.totals.regenerable.logicalBytes, 47);
    assert.equal(result.totals.unreviewed.files, 0);
    assert.equal(result.rows.find(row => row.relativePath === 'mixed/empty.txt').files, 1);
    assert.ok(result.rows.every(row => row.scope === 'file'));
    assert.ok(result.rows.every(row => row.modifiedAt === timestamp));
  }
  assertMeasuredExactlyOnce(scan, run(scan, entries, { focus: 'mixed/child' }), 'mixed/child');
});

test('retired file rows preserve full retirement evidence without claiming regeneration or absorbing neighboring files', () => {
  const scan = snapshot();
  const entry = retiredFile('mixed/duplicate.bin');
  const report = run(scan, [entry, decision('mixed/unique.cs', 'keep'),
    decision('mixed/child/generated.bin', 'regenerable')]);
  assertMeasuredExactlyOnce(scan, report);
  assert.deepEqual(report.totals.retired, { logicalBytes: 101, files: 1, rows: 1 });
  assert.equal(report.totals.regenerable.logicalBytes, 47);
  assert.equal(report.totals.keep.logicalBytes, 17);
  assert.equal(report.totals.unreviewed.logicalBytes, 23);
  const row = report.rows.find(row => row.relativePath === entry.relativePath);
  assert.equal(row.scope, 'file');
  assert.deepEqual(row.retirement, entry.retirement);
  assert.deepEqual(row.evidence, entry.evidence);
  assert.deepEqual(row.prerequisites, entry.prerequisites);
  assert.equal(row.regenerate, null);
  assert.equal(row.modifiedAt, timestamp);
  assert.equal(row.deletionApproved, false);
  assert.equal(report.deletionPlan, false);
  assert.match(formatReview(report), /retired: .*1 files, 1 groups/);
  const residual = report.rows.find(row => row.scope === 'direct' && row.relativePath === 'mixed');
  assert.equal(residual.files, 2);
  assert.equal(residual.retirement, null);
  assert.deepEqual(residual.excludedFiles, ['duplicate.bin', 'unique.cs']);
});

test('retired files remain blocked by Git storage incomplete direct measurement and overlapping scopes', () => {
  const scan = snapshot({ 'mixed': { 'old.bin': 13 }, '.git/objects': { 'object.bin': 11 },
    worktree: { '.git': 9 }, store: { HEAD: 17 }, 'store/objects': { 'pack.bin': 19 } });
  nodeAt(scan, 'worktree').directGitMarkers = ['.git'];
  nodeAt(scan, 'store').directGitMarkers = ['HEAD', 'objects'];
  for (const relativePath of ['.git/objects/object.bin', 'worktree/.git', 'store/HEAD', 'store/objects/pack.bin']) {
    assert.throws(() => run(scan, [retiredFile(relativePath)]), /Git metadata/);
  }
  const missing = snapshot(); delete nodeAt(missing, 'mixed').directGitMarkers;
  assert.throws(() => run(missing, [retiredFile('mixed/duplicate.bin')]), /Git marker evidence/);
  for (const [total, direct] of [['errorCount', 'directErrorCount'], ['skippedCount', 'directSkippedCount']]) {
    const incomplete = snapshot();
    nodeAt(incomplete, 'mixed')[direct] = 1;
    nodeAt(incomplete, 'mixed')[total] = 1;
    nodeAt(incomplete, '.')[total] = 1;
    incomplete[total] = 1;
    assert.throws(() => run(incomplete, [retiredFile('mixed/duplicate.bin')]), /Incomplete measurement cannot be marked retired/);
  }
  const pair = [decision('mixed', 'keep', 'direct'), retiredFile('mixed/duplicate.bin')];
  for (const entries of [pair, [...pair].reverse()]) assert.throws(() => run(snapshot(), entries), /Overlapping/);
  const missingEvidence = retiredFile('mixed/duplicate.bin');
  delete missingEvidence.retirement.consumerAudit;
  assert.throws(() => run(snapshot(), [missingEvidence]), /Retirement/);
});

test('zero-length file alone survives selection without creating an empty residual row', () => {
  const scan = snapshot({ empty: { 'zero.bin': 0 } });
  const result = run(scan, [decision('empty/zero.bin', 'keep')]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].scope, 'file');
  assert.equal(result.files, 1);
  assert.equal(result.logicalBytes, 0);
  assertMeasuredExactlyOnce(scan, result);
});

test('unknown files directory paths and files without detail snapshots cannot be selected', () => {
  const scan = snapshot();
  for (const relativePath of ['mixed/missing.bin', 'mixed/child', 'absent/file.bin', '.']) {
    assert.throws(() => run(scan, [decision(relativePath)]), /matching|Invalid|details/);
  }
  for (const missing of [null, undefined]) {
    const altered = structuredClone(scan);
    nodeAt(altered, 'mixed').directFileEntries = missing;
    assert.throws(() => run(altered, [decision('mixed/duplicate.bin')]), /file-details/);
    assert.equal(run(altered).logicalBytes, scan.totals.logicalBytes);
  }
});

test('noncanonical and malformed file detail names are rejected before decisions are applied', () => {
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'bad\0name', null, 42]) {
    const scan = snapshot({ mixed: { valid: 1 } });
    nodeAt(scan, 'mixed').directFileEntries[0].name = name;
    assert.throws(() => run(scan), /file detail name/, `name ${JSON.stringify(name)}`);
  }
  for (const relativePath of ['../outside.bin', '/outside.bin', 'C:/outside.bin', 'mixed//duplicate.bin', 'mixed/./duplicate.bin', 'mixed/../duplicate.bin']) {
    assert.throws(() => run(snapshot(), [decision(relativePath)]), /relative|canonical/);
  }
});

test('duplicate detail names and inconsistent detail byte or file totals are rejected', () => {
  const mutations = [
    node => { node.directFileEntries[1].name = node.directFileEntries[0].name; },
    node => { node.directFileEntries[0].logicalBytes++; },
    node => { node.directFileEntries.pop(); },
    node => { node.directFileEntries.push({ name: 'extra-zero', logicalBytes: 0 }); },
    node => { node.directFileEntries = {}; },
    node => { node.directFileEntries[0].logicalBytes = -1; },
    node => { node.directFileEntries[0].logicalBytes = NaN; },
  ];
  for (const mutate of mutations) {
    const scan = snapshot(); mutate(nodeAt(scan, 'mixed'));
    assert.throws(() => run(scan), /detail|logicalBytes/);
  }
});

test('overlapping direct tree and file selections fail in both orders including kept ancestors', () => {
  const pairs = [
    [decision('mixed', 'keep', 'direct'), decision('mixed/duplicate.bin')],
    [decision('mixed', 'keep', 'tree'), decision('mixed/duplicate.bin')],
    [decision('mixed/child', 'keep', 'tree'), decision('mixed/child/generated.bin')],
    [decision('mixed/duplicate.bin', 'keep'), decision('mixed/duplicate.bin')],
  ];
  for (const pair of pairs) for (const entries of [pair, [...pair].reverse()]) {
    assert.throws(() => run(snapshot(), entries), /Overlapping/);
  }
  const scan = snapshot();
  const result = run(scan, [decision('mixed', 'keep', 'direct'), decision('mixed/child/generated.bin')]);
  assertMeasuredExactlyOnce(scan, result);
});

test('file candidates cannot bypass Git directory gitfile or renamed bare storage protection', () => {
  const scan = snapshot({ '.': { 'generated.bin': 31 }, '.git/objects': { 'object.bin': 11 }, worktree: { '.git': 9 },
    store: { HEAD: 17, config: 5 }, 'store/objects': { 'pack.bin': 19 } });
  nodeAt(scan, '.').directGitMarkers = ['.git'];
  nodeAt(scan, 'worktree').directGitMarkers = ['.git'];
  nodeAt(scan, 'store').directGitMarkers = ['HEAD', 'objects'];
  for (const relativePath of ['worktree/.git', '.git/objects/object.bin', 'store/HEAD', 'store/config', 'store/objects/pack.bin']) {
    for (const disposition of ['regenerable', 'conditional']) {
      assert.throws(() => run(scan, [decision(relativePath, disposition)]), /Git metadata/);
    }
  }
  const kept = run(scan, [decision('.git/objects/object.bin', 'keep'), decision('store/HEAD', 'keep')]);
  assert.equal(kept.totals.keep.logicalBytes, scan.totals.logicalBytes);
  for (const relativePath of ['.git/objects/object.bin', 'store/HEAD']) {
    const explicit = kept.rows.find(row => row.scope === 'file' && row.relativePath === relativePath);
    assert.ok(explicit, `Explicit keep evidence remains visible for ${relativePath}`);
    assert.equal(explicit.disposition, 'keep');
    assert.equal(explicit.reason, 'Fixture content and consumer references were checked');
    assert.deepEqual(explicit.evidence, ['fixture comparison and consumer manifest']);
  }
  assertMeasuredExactlyOnce(scan, kept);
  // A repository boundary protects Git, but does not hide a separately reviewed
  // ordinary immediate file from the ledger.
  const generated = run(scan, [decision('generated.bin')]);
  assert.equal(generated.totals.conditional.logicalBytes, 31);
  assertMeasuredExactlyOnce(scan, generated);
});

test('file candidate requires marker evidence and cannot clear unresolved direct diagnostics', () => {
  const missing = snapshot(); delete nodeAt(missing, 'mixed').directGitMarkers;
  assert.throws(() => run(missing, [decision('mixed/duplicate.bin')]), /Git marker evidence/);
  const incomplete = snapshot();
  nodeAt(incomplete, 'mixed').directSkippedCount = 1;
  nodeAt(incomplete, 'mixed').skippedCount = 1;
  nodeAt(incomplete, '.').skippedCount = 1;
  incomplete.skippedCount = 1;
  assert.throws(() => run(incomplete, [decision('mixed/duplicate.bin', 'regenerable')]), /Incomplete measurement/);
  const conditional = run(incomplete, [decision('mixed/duplicate.bin')]);
  assert.equal(conditional.unmeasured.logicalBytes, null);
  assert.equal(conditional.rows.reduce((sum, row) => sum + row.skippedCount, 0), 1);
  assertMeasuredExactlyOnce(incomplete, conditional);
});
