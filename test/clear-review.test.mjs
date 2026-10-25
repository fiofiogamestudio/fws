import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanSpace } from '../skills/fw-clear/scripts/scan-space.mjs';
import { reviewSpace, formatReview, parseReviewArgs, reviewHint } from '../skills/fw-clear/scripts/review-space.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/review-space.mjs', import.meta.url));
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '.';
const inside = (child, parent) => parent === '.' || child === parent || child.startsWith(`${parent}/`);

// Each entry describes the files directly in one directory. Ancestors and all
// subtree counters are constructed independently of the review implementation.
function inventory(entries, root = path.join(os.tmpdir(), 'review-only-project')) {
  const nodes = new Map();
  const add = relativePath => {
    if (!nodes.has(relativePath)) nodes.set(relativePath, {
      relativePath, parentRelativePath: relativePath === '.' ? null : parentOf(relativePath),
      logicalBytes: 0, directBytes: 0, files: 0, directFiles: 0, directories: 1, childDirectories: 0,
      directGitMarkers: [],
      errorCount: 0, directErrorCount: 0, skippedCount: 0, directSkippedCount: 0,
      earliestFileMtime: null, latestFileMtime: null,
    });
    if (relativePath !== '.') add(parentOf(relativePath));
    return nodes.get(relativePath);
  };
  add('.');
  for (const [relativePath, spec] of Object.entries(entries)) {
    const data = typeof spec === 'number' ? { bytes: spec } : spec;
    const row = add(relativePath);
    row.directBytes = data.bytes ?? 0;
    row.directFiles = data.files ?? (row.directBytes ? 1 : 0);
    row.directErrorCount = data.errors ?? 0;
    row.directSkippedCount = data.skipped ?? 0;
  }
  const rows = [...nodes.values()].sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length || (a.relativePath === '.' ? 1 : -1));
  for (const row of rows) {
    row.logicalBytes += row.directBytes;
    row.files += row.directFiles;
    row.errorCount += row.directErrorCount;
    row.skippedCount += row.directSkippedCount;
    if (row.relativePath !== '.') {
      const parent = nodes.get(row.parentRelativePath);
      parent.logicalBytes += row.logicalBytes;
      parent.files += row.files;
      parent.directories += row.directories;
      parent.childDirectories++;
      parent.errorCount += row.errorCount;
      parent.skippedCount += row.skippedCount;
    }
  }
  const totals = nodes.get('.');
  return { schemaVersion: 2, root, finishedAt: '2026-10-25T01:02:03.000Z', measurement: 'logical-file-lengths', consistentSnapshot: false,
    inventoryEnabled: true, inventoryComplete: true, inventory: rows, totals: { ...totals },
    errorCount: totals.errorCount, skippedCount: totals.skippedCount,
    measurementComplete: !totals.errorCount && !totals.skippedCount };
}

function decisions(scan, values) {
  return { schemaVersion: 1, root: scan.root, scanFinishedAt: scan.finishedAt, decisions: values.map(value => ({
    scope: 'tree', disposition: 'regenerable', reason: 'Reviewed generated fixture output',
    evidence: ['Generator configuration and consumer references checked'], regenerate: 'Run the fixture generator', prerequisites: [], ...value,
  })) };
}

function retired(relativePath, scope = 'tree') {
  return { relativePath, scope, disposition: 'retired', regenerate: undefined,
    reason: 'Completed diagnostic output has left use', evidence: ['Completed task and retained result inventory'],
    prerequisites: ['Recheck no running producer or current consumer'],
    retirement: { generatedBy: 'Unity batch test runner', completionEvidence: ['results.xml confirms completion'],
      consumerAudit: 'No current build, playback or review entry consumes this output',
      preservedEvidence: ['results.xml and final capture.mp4 remain'],
      impact: 'Old verbose diagnostics are lost; exact historical bytes will not be recreated' } };
}

function assertPartition(scan, review, focus = '.') {
  const measured = scan.inventory.map(row => ({ ...row, relativePath: row.relativePath.replaceAll('\\', '/') })).filter(row => inside(row.relativePath, focus));
  for (const bucket of measured.filter(row => row.directFiles || row.directBytes || row.directErrorCount || row.directSkippedCount)) {
    const owners = review.rows.filter(row => row.scope === 'direct' ? row.relativePath === bucket.relativePath : inside(bucket.relativePath, row.relativePath));
    assert.equal(owners.length, 1, `Every direct bucket has exactly one owner: ${bucket.relativePath}`);
  }
  assert.equal(review.logicalBytes, measured.reduce((sum, row) => sum + row.directBytes, 0));
  assert.equal(review.files, measured.reduce((sum, row) => sum + row.directFiles, 0));
  assert.equal(Object.values(review.totals).reduce((sum, group) => sum + group.logicalBytes, 0), review.logicalBytes);
  assert.equal(review.rows.reduce((sum, row) => sum + row.errorCount, 0), review.unmeasured.errorCount);
  assert.equal(review.rows.reduce((sum, row) => sum + row.skippedCount, 0), review.unmeasured.skippedCount);
  assert.ok(review.rows.every(row => row.deletionApproved === false));
  assert.equal(review.deletionPlan, false);
}

test('arbitrarily deep and wide inventories partition every measured bucket exactly once at all chunk sizes', () => {
  const entries = { '.': 17, 'Assets/source': 23, '.git/objects': 31, 'Library/manual-tool/.git/objects': 19, 'Library/manual-tool/src': 29 };
  for (let i = 0; i < 125; i++) entries[`outputs/batch-${i}/worker/cache`] = { bytes: i + 1, files: (i % 7) + 1 };
  let deep = 'Library';
  for (let i = 0; i < 45; i++) { deep += `/level-${i}`; entries[deep] = { bytes: i + 3, files: 3 }; }
  const scan = inventory(entries);
  for (const chunkMiB of [0.000001, 0.0001, 1, 1024]) {
    const result = reviewSpace(scan, { chunkMiB });
    assertPartition(scan, result);
    assert.equal(result.partitionCoveragePercent, 100);
    assert.equal(result.totals.regenerable.logicalBytes, 0);
    assert.equal(result.totals.conditional.logicalBytes, 0);
    assert.equal(result.totals.keep.logicalBytes, 50);
    assert.equal(result.unmeasured.logicalBytes, 0);
  }
});

test('partial measurements retain zero-byte diagnostic rows and never imply a known unmeasured size', () => {
  const scan = inventory({ '.': 7, 'cache/known': 13, 'cache/denied': { errors: 3 }, 'cache/links': { skipped: 2 }, 'source': 11 });
  for (const chunkMiB of [0.000001, 1024]) {
    const result = reviewSpace(scan, { chunkMiB });
    assertPartition(scan, result);
    assert.deepEqual(result.unmeasured, { errorCount: 3, skippedCount: 2, logicalBytes: null });
    assert.match(formatReview(result), /bytes: unknown/);
  }
  assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache' }]) }), /Incomplete measurement/);
  const conditional = reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache', disposition: 'conditional' }]) });
  assert.equal(conditional.totals.conditional.logicalBytes, 13);
  assert.equal(conditional.totals.regenerable.logicalBytes, 0);
  assert.equal(conditional.unmeasured.logicalBytes, null);
  assertPartition(scan, conditional);
});

test('explicit direct and tree decisions retain separate regenerable conditional kept and unreviewed totals', () => {
  const scan = inventory({ '.': 2, 'cache': 3, 'cache/generated': 11, 'cache/history': 13, 'cache/manual': 17, 'Assets': 19 });
  const result = reviewSpace(scan, { decisions: decisions(scan, [
    { relativePath: 'cache', scope: 'direct', disposition: 'keep' },
    { relativePath: 'cache/generated' },
    { relativePath: 'cache/history', disposition: 'conditional', prerequisites: ['Confirm old evidence is no longer required'] },
    { relativePath: 'cache/manual', disposition: 'keep' },
  ]) });
  assertPartition(scan, result);
  assert.equal(result.totals.regenerable.logicalBytes, 11);
  assert.equal(result.totals.conditional.logicalBytes, 13);
  assert.equal(result.totals.keep.logicalBytes, 20);
  assert.equal(result.totals.unreviewed.logicalBytes, 21);
  assert.equal(result.reviewedPercent, 44 / 65 * 100);
  assert.equal(result.rows.find(row => row.relativePath === 'cache/history').prerequisites.length, 1);
});

test('retired tree and direct scopes are separate from regenerable totals and retain their retirement evidence', () => {
  const scan = inventory({ '.': 2, output: 3, 'output/finished': 11, 'output/finished/child': 5,
    'output/generated': 13, 'output/current': 17, 'output/undecided': 19 });
  const retiredTree = retired('output/finished');
  const retiredDirect = retired('output', 'direct');
  const entries = [retiredTree, retiredDirect, { relativePath: 'output/generated' },
    { relativePath: 'output/current', disposition: 'keep' }];
  const result = reviewSpace(scan, { decisions: decisions(scan, entries) });
  assertPartition(scan, result);
  assert.deepEqual(result.totals.retired, { logicalBytes: 19, files: 3, rows: 2 });
  assert.equal(result.totals.regenerable.logicalBytes, 13);
  assert.equal(result.totals.conditional.logicalBytes, 0);
  assert.equal(result.totals.keep.logicalBytes, 17);
  assert.equal(result.totals.unreviewed.logicalBytes, 21);
  for (const entry of [retiredTree, retiredDirect]) {
    const row = result.rows.find(row => row.relativePath === entry.relativePath);
    assert.deepEqual(row.retirement, entry.retirement);
    assert.deepEqual(row.prerequisites, entry.prerequisites);
    assert.equal(row.regenerate, null, 'Retirement must not require a claim of historical reproduction');
  }
  assert.match(formatReview(result), /retired: .*3 files, 2 groups/);
  assert.match(formatReview(result), /not a deletion plan/);
  const focused = reviewSpace(scan, { focus: 'output/finished/child', decisions: decisions(scan, entries) });
  assertPartition(scan, focused, 'output/finished/child');
  assert.deepEqual(focused.rows[0].retirement, retiredTree.retirement);
  assert.equal(reviewSpace(scan).totals.retired.logicalBytes, 0, 'Size and output names never infer retirement');
});

test('retirement rejects missing or malformed generation completion consumer preservation and impact evidence', () => {
  const scan = inventory({ output: 7 });
  for (const field of ['generatedBy', 'completionEvidence', 'consumerAudit', 'preservedEvidence', 'impact']) {
    const invalidValues = ['completionEvidence', 'preservedEvidence'].includes(field)
      ? [undefined, null, [], [''], [' '], [1], Array(1), 'a receipt']
      : [undefined, null, '', ' ', 1, ['a fact']];
    for (const value of invalidValues) {
      const entry = retired('output');
      entry.retirement[field] = value;
      assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [entry]) }), /Retirement/, `${field}: ${JSON.stringify(value)}`);
    }
  }
  for (const value of [undefined, null, [], 'completed']) {
    const entry = { ...retired('output'), retirement: value };
    assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [entry]) }), /Retirement/);
  }
  for (const mutation of [entry => { delete entry.reason; }, entry => { entry.reason = 42; },
    entry => { entry.evidence = []; }, entry => { delete entry.prerequisites; },
    entry => { entry.prerequisites = [' ']; }, entry => { entry.prerequisites = Array(1); }]) {
    // The helper supplies normal defaults, so remove fields from the bound decision itself.
    const bound = decisions(scan, [retired('output')]); mutation(bound.decisions[0]);
    assert.throws(() => reviewSpace(scan, { decisions: bound }), /Reason|evidence|Prerequisites/);
  }
});

test('retired scopes cannot bypass root Git boundaries missing markers incomplete measurements or overlaps', () => {
  const protectedScan = inventory({ '.': 7, '.git/objects': 11, 'output/tool/.git/objects': 13,
    'output/tool/src': 17, ordinary: 19 });
  for (const relativePath of ['.', '.git', '.git/objects', 'output', 'output/tool']) {
    assert.throws(() => reviewSpace(protectedScan, { decisions: decisions(protectedScan, [retired(relativePath)]) }), /project|Git/i);
  }
  assert.throws(() => reviewSpace(protectedScan, { decisions: decisions(protectedScan, [retired('.', 'direct')]) }), /project|root/i);
  const missing = inventory({ output: 7 });
  delete missing.inventory.find(node => node.relativePath === 'output').directGitMarkers;
  assert.throws(() => reviewSpace(missing, { decisions: decisions(missing, [retired('output')]) }), /Git marker evidence/);
  for (const diagnostic of ['errors', 'skipped']) for (const scope of ['tree', 'direct']) {
    const scan = inventory({ output: { bytes: 7, [diagnostic]: 1 } });
    assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [retired('output', scope)]) }), /Incomplete measurement cannot be marked retired/);
  }
  const descendantDiagnostic = inventory({ output: 7, 'output/unknown': { skipped: 1 } });
  assert.throws(() => reviewSpace(descendantDiagnostic, { decisions: decisions(descendantDiagnostic, [retired('output')]) }), /Incomplete measurement/);
  const exactDirect = reviewSpace(descendantDiagnostic, { decisions: decisions(descendantDiagnostic, [retired('output', 'direct')]) });
  assert.equal(exactDirect.totals.retired.logicalBytes, 7);
  assert.equal(exactDirect.unmeasured.logicalBytes, null, 'Retiring known direct files does not erase unknown descendants');
  assertPartition(descendantDiagnostic, exactDirect);
  const scan = inventory({ output: 7, 'output/child': 11 });
  const pair = [retired('output'), { relativePath: 'output/child', disposition: 'keep' }];
  for (const entries of [pair, [...pair].reverse()]) assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, entries) }), /Overlapping/);
});

test('overlapping decisions fail in either order while ancestor direct files and descendant trees coexist', () => {
  const scan = inventory({ cache: 3, 'cache/child': 5, 'cache/child/leaf': 7 });
  for (const pair of [
    [{ relativePath: 'cache' }, { relativePath: 'cache/child' }],
    [{ relativePath: 'cache', scope: 'direct' }, { relativePath: 'cache' }],
    [{ relativePath: 'cache/child', scope: 'direct' }, { relativePath: 'cache/child', scope: 'direct' }],
  ]) for (const values of [pair, [...pair].reverse()]) assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, values) }), /Overlapping/);
  const result = reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache', scope: 'direct' }, { relativePath: 'cache/child' }]) });
  assertPartition(scan, result);
  assert.equal(result.totals.regenerable.logicalBytes, 15);
});

test('project root and Git trees cannot become candidates even through a mixed ancestor', () => {
  const scan = inventory({ '.': 7, '.git/objects': 11, 'cache/tool/.git/objects': 13, 'cache/tool/src': 17 });
  for (const relativePath of ['.', '.git', '.git/objects', 'cache', 'cache/tool', 'cache/tool/.git']) {
    for (const disposition of ['regenerable', 'conditional']) assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath, disposition }]) }), /project|Git/i);
  }
  assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: '.', scope: 'direct' }]) }), /project|root|Git/i);
  const kept = reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: '.', disposition: 'keep' }]) });
  assert.equal(kept.totals.keep.logicalBytes, 48);
  assertPartition(scan, kept);
});

test('focus applies ancestor decisions only to the focused subtree and preserves its own diagnostic bounds', () => {
  const scan = inventory({ '.': 1, cache: 2, 'cache/a': 3, 'cache/a/deep': 5, 'cache/b': 7, other: { bytes: 11, errors: 1 } });
  const approved = decisions(scan, [{ relativePath: 'cache', disposition: 'conditional' }]);
  const result = reviewSpace(scan, { focus: 'cache/a', decisions: approved });
  assertPartition(scan, result, 'cache/a');
  assert.equal(result.logicalBytes, 8);
  assert.equal(result.totals.conditional.logicalBytes, 8);
  assert.equal(result.unmeasured.logicalBytes, 0);
  assert.ok(result.rows.every(row => inside(row.relativePath, 'cache/a')));
  assert.throws(() => reviewSpace(scan, { focus: 'missing' }), /missing/);
  assert.throws(() => reviewSpace(scan, { focus: '../outside' }), /relative|canonical/i);
});

test('truncated text states the exact residual group count and bytes while JSON stays complete', () => {
  const scan = inventory(Object.fromEntries(Array.from({ length: 75 }, (_, index) => [`branch-${index}`, 1024 ** 3])));
  const report = reviewSpace(scan);
  assert.equal(report.rows.length, 75);
  assert.match(formatReview(report, 2), /Not displayed: 73 groups, 73\.000 GiB; all retained in JSON/);
  assert.match(formatReview(report, 0), /Not displayed: 75 groups, 75\.000 GiB/);
  assert.match(formatReview(report, 100), /Not displayed: 0 groups, 0\.000 GiB/);
  assert.equal(report.rows.length, 75);
  assert.throws(() => formatReview(report, -1), /limit/);
});

test('malformed paths missing parents duplicate rows and non-reconciling bytes are rejected', () => {
  const valid = inventory({ '.': 1, 'cache/deep': 3 });
  const mutate = fn => { const value = structuredClone(valid); fn(value); return value; };
  for (const invalid of [
    mutate(s => { s.inventoryComplete = false; }),
    mutate(s => { s.inventory = null; }),
    mutate(s => { s.inventory.push({ ...s.inventory[0] }); }),
    mutate(s => { s.inventory[0].relativePath = '../outside'; }),
    mutate(s => { s.inventory[0].relativePath = '/outside'; }),
    mutate(s => { s.inventory[0].relativePath = 'cache//deep'; }),
    mutate(s => { s.inventory = s.inventory.filter(row => row.relativePath !== 'cache'); }),
    mutate(s => { s.inventory[0].directBytes++; }),
    mutate(s => { s.inventory[0].directFiles = -1; }),
    mutate(s => { s.totals.logicalBytes++; }),
  ]) assert.throws(() => reviewSpace(invalid));
  for (const chunkMiB of [0, -1, NaN, Infinity]) assert.throws(() => reviewSpace(valid, { chunkMiB }), /chunkMiB/);
});

test('diagnostic mismatches cannot hide incomplete measurements inside a regenerable ancestor', () => {
  const scan = inventory({ '.': 1, 'cache/deep': { bytes: 3, errors: 1, skipped: 1 } });
  const hiddenChild = structuredClone(scan);
  hiddenChild.inventory.find(row => row.relativePath === 'cache').errorCount = 0;
  hiddenChild.inventory.find(row => row.relativePath === 'cache').skippedCount = 0;
  assert.throws(() => reviewSpace(hiddenChild, { decisions: decisions(hiddenChild, [{ relativePath: 'cache' }]) }), /diagnostic|reconcile|measurement/i);
  const hiddenTotal = structuredClone(scan);
  hiddenTotal.errorCount = 0;
  hiddenTotal.skippedCount = 0;
  assert.throws(() => reviewSpace(hiddenTotal), /diagnostic|total|measurement/i);
  const falseComplete = structuredClone(scan);
  falseComplete.inventoryComplete = 'false';
  assert.throws(() => reviewSpace(falseComplete), /complete|inventory/i);
});

test('decisions bind to the exact scan and require meaningful evidence and regeneration text', () => {
  // Keep the fixture on cwd's drive: Windows path.relative across drives
  // returns an absolute path, which would not exercise relative-root rejection.
  const scan = inventory({ cache: 3 }, path.join(process.cwd(), 'review-fixture'));
  for (const update of [
    d => { d.scanFinishedAt = '2020-01-01'; },
    d => { d.root = path.join(scan.root, 'other'); },
    d => { d.root = path.relative(process.cwd(), scan.root); },
    d => { d.schemaVersion = 2; },
    d => { d.decisions[0].relativePath = 'missing'; },
    d => { d.decisions[0].scope = 'all'; },
    d => { d.decisions[0].disposition = 'unreviewed'; },
    d => { d.decisions[0].reason = ' '; },
    d => { d.decisions[0].evidence = []; },
    d => { d.decisions[0].evidence = [' ']; },
    d => { d.decisions[0].regenerate = ''; },
    d => { d.decisions[0].prerequisites = 'close editor'; },
    d => { d.decisions[0].prerequisites = [null]; },
    d => { d.decisions[0].prerequisites = [' ']; },
  ]) { const input = decisions(scan, [{ relativePath: 'cache' }]); update(input); assert.throws(() => reviewSpace(scan, { decisions: input })); }
  const unidentified = structuredClone(scan);
  delete unidentified.finishedAt;
  const unbound = decisions(unidentified, [{ relativePath: 'cache' }]);
  delete unbound.scanFinishedAt;
  assert.throws(() => reviewSpace(unidentified, { decisions: unbound }), /scan|finishedAt|timestamp/i);
});

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-review-test-'));
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const relative = path.relative(await fs.realpath(os.tmpdir()), realParent);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'project');
  await fs.mkdir(root);
  return { parent, root };
}

test('real nested Git worktree marker files keep their whole direct-file bucket out of candidates', async t => {
  const { root } = await fixture(t);
  const nested = path.join(root, 'cache', 'manual-worktree');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, '.git'), 'gitdir: D:/external-repository/.git/worktrees/manual-worktree\n');
  await fs.writeFile(path.join(nested, 'manual-source.gd'), 'extends Node\n');
  const scan = await scanSpace(root, { inventory: true });
  for (const relativePath of ['cache', 'cache/manual-worktree']) {
    assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath }]) }), /Git|worktree|repository/i);
  }
  assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache/manual-worktree', scope: 'direct' }]) }), /Git|worktree|repository/i);
  const result = reviewSpace(scan);
  assertPartition(scan, result);
  assert.equal(result.totals.regenerable.logicalBytes, 0);
  assert.ok(result.rows.some(row => row.relativePath === 'cache/manual-worktree' && row.directGitMarkers?.includes('.git')), 'A nested Git file must stay visible even when the parent cache is small.');
});

test('bare repository and linked-admin metadata remain protected when focusing or selecting below the marker', () => {
  for (const markers of [['HEAD', 'objects', 'refs'], ['HEAD', 'commondir', 'gitdir'], ['head', 'OBJECTS', 'Refs'], ['head', 'CommonDir', 'GitDir']]) {
    const scan = inventory({ 'cache/repository': 7, 'cache/repository/objects/pack': 13, 'cache/repository/logs': 3, 'ordinary-cache': 5 });
    scan.inventory.find(row => row.relativePath === 'cache/repository').directGitMarkers = markers;
    for (const relativePath of ['cache/repository/objects', 'cache/repository/objects/pack', 'cache/repository/logs']) {
      for (const scope of ['tree', 'direct']) assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath, scope }]) }), /Git|repository|metadata/i);
    }
    const focused = reviewSpace(scan, { focus: 'cache/repository/objects' });
    assertPartition(scan, focused, 'cache/repository/objects');
    assert.equal(focused.totals.keep.logicalBytes, 13);
    const ordinary = reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'ordinary-cache' }]) });
    assert.equal(ordinary.totals.regenerable.logicalBytes, 5);
  }
});

test('case-preserved Git markers remain visible and protect direct-file buckets', () => {
  const scan = inventory({ 'cache/worktree': 7, 'cache/worktree/generated': 11 });
  scan.inventory.find(row => row.relativePath === 'cache/worktree').directGitMarkers = ['.GIT'];
  const result = reviewSpace(scan);
  assertPartition(scan, result);
  assert.ok(result.rows.some(row => row.relativePath === 'cache/worktree' && row.directGitMarkers?.includes('.GIT') && row.disposition === 'keep'));
  assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache/worktree', scope: 'direct' }]) }), /Git|repository/i);
  // A normal repository's regenerable child cache is not Git object storage.
  const child = reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache/worktree/generated' }]) });
  assert.equal(child.totals.regenerable.logicalBytes, 11);
});

test('older inventories without Git marker evidence permit discovery but cannot authorize candidate classification', () => {
  const scan = inventory({ 'cache/generated': 9 });
  for (const node of scan.inventory) delete node.directGitMarkers;
  const discovery = reviewSpace(scan);
  assertPartition(scan, discovery);
  assert.equal(discovery.totals.unreviewed.logicalBytes, 9);
  assert.throws(() => reviewSpace(scan, { decisions: decisions(scan, [{ relativePath: 'cache' }]) }), /Git marker evidence/);
});

test('CLI produces a read-only ledger and rejects mutation flags without changing any project files', async t => {
  const { parent, root } = await fixture(t);
  const source = path.join(root, 'required-source.txt');
  await fs.writeFile(source, 'keep exactly\n');
  const input = path.join(parent, 'scan.json');
  await fs.writeFile(input, JSON.stringify(await scanSpace(root, { inventory: true })));
  const beforeNames = await fs.readdir(root);
  const beforeStat = await fs.stat(source);
  const beforeBytes = await fs.readFile(source);
  const { stdout, stderr } = await run(process.execPath, [script, '--scan', input, '--json']);
  const report = JSON.parse(stdout);
  assert.equal(stderr, '');
  assert.equal(report.deletionPlan, false);
  assert.equal(report.totals.unreviewed.logicalBytes, beforeBytes.length);
  assert.deepEqual(await fs.readdir(root), beforeNames);
  assert.deepEqual(await fs.readFile(source), beforeBytes);
  assert.equal((await fs.stat(source)).mtimeMs, beforeStat.mtimeMs);
  await assert.rejects(run(process.execPath, [script, '--scan', input, '--apply']), /Invalid or duplicate option/);
});

test('argument validation and hints do not infer deletion from cache source or output names', () => {
  assert.equal(reviewHint('Library/cache'), 'cache-or-build-needs-provenance');
  assert.equal(reviewHint('Library/tool/src'), 'source-or-input');
  assert.equal(reviewHint('outputs/replays'), 'mixed-output-split-inputs-evidence-delivery');
  assert.equal(reviewHint('tools/.git/objects'), 'git-metadata');
  assert.equal(parseReviewArgs(['--help']).help, true);
  assert.deepEqual(parseReviewArgs(['--scan', 'scan.json', '--focus', 'cache', '--chunk-mib', '0.5', '--limit', '0']), { scan: 'scan.json', focus: 'cache', chunkMiB: 0.5, limit: 0 });
  for (const args of [[], ['--scan'], ['--scan', 'x', '--scan', 'y'], ['--scan', 'x', '--delete'], ['--scan', 'x', '--limit', '-1']]) assert.throws(() => parseReviewArgs(args));
});
