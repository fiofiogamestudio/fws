import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createCleanupBundle, parseArguments } from '../skills/fw-clear/scripts/create-cleanup-bundle.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-bundle-test-'));
  if (windows) assert.match(parent, /^C:\\/i, 'Destructive fixtures must live in C: OS Temp.');
  const root = path.join(parent, '工程 & % !');
  const target = path.join(root, '缓存 & % !');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, '文件 & % !.bin'), 'fixture data');
  await fs.writeFile(path.join(root, 'keep-source.cs'), 'must remain');
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const temp = await fs.realpath(os.tmpdir());
    const relative = path.relative(temp, realParent);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  return { parent, root, target };
}

async function generate(f, options = {}) {
  const manifest = path.join(f.parent, 'manifest.json');
  const out = path.join(f.parent, '清理包 & % !');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root], targets: [{ path: f.target, reason: 'Disposable test cache', ...options }] }), 'utf8');
  return { ...await createCleanupBundle({ manifest, out }), manifest, out };
}

async function execute(bundle, apply = false) {
  try {
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle.out, 'execute-cleanup.ps1'), '-PlanPath', path.join(bundle.out, 'cleanup-plan.json'), ...(apply ? ['-Apply'] : [])], { windowsHide: true });
    return { exitCode: 0, output: result.stdout, report: JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8')) };
  } catch (error) {
    const report = await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8').then(JSON.parse).catch(() => null);
    return { exitCode: error.code, output: error.stdout + error.stderr, report };
  }
}

test('cleanup CLI refuses missing, repeated, unknown and relative arguments', () => {
  assert.throws(() => parseArguments([]), /required/);
  assert.throws(() => parseArguments(['--out', 'x', '--out', 'y']), /Usage/);
  assert.throws(() => parseArguments(['--delete-all', 'x']), /Usage/);
  assert.deepEqual(parseArguments(['--manifest', 'a', '--out', 'b']), { manifest: 'a', out: 'b' });
});

test('generated cleanup BAT safely deletes Unicode/metacharacter paths without a preview BAT; repeat runs are explicit', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  assert.deepEqual((await fs.readdir(bundle.out)).sort(), ['README.txt', 'cleanup-plan.json', 'cleanup.bat', 'execute-cleanup.ps1'].sort());
  assert.ok(!(await fs.readFile(path.join(bundle.out, 'README.txt'), 'ascii')).includes('preview.bat'));
  const plan = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-plan.json'), 'utf8'));
  assert.equal(plan.targets[0].snapshot.logicalBytes, 12);
  assert.equal(plan.targets[0].snapshot.files, 1);
  assert.equal(plan.targets[0].snapshot.algorithm, 'sha256-sorted-path-type-length-mtimeUtcTicks-v1');
  assert.ok(!JSON.stringify(plan).includes('文件 &'), 'Plan stores an aggregate snapshot, not all file paths.');
  // Exercise the executor's internal read-only mode without a user-facing BAT.
  const validation = await execute(bundle);
  assert.equal(validation.exitCode, 0, validation.output);
  assert.equal(validation.report.targets[0].status, 'ready');
  assert.equal(validation.report.removedLogicalBytes, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain');
  assert.ok(await fs.stat(f.target));
  // Run cmd against the real generated BAT with a newline for its final pause.
  const batResult = await new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(bundle.out, 'cleanup.bat')}""`], { windowsHide: true, windowsVerbatimArguments: true });
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { output += chunk; });
    proc.on('error', reject);
    proc.on('close', exitCode => resolve({ exitCode, output }));
    proc.stdin.end('\r\n');
  });
  assert.equal(batResult.exitCode, 0, batResult.output);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const report = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8'));
  assert.equal(report.targets[0].status, 'deleted');
  assert.equal(report.removedLogicalBytes, 12);
  const archives = (await fs.readdir(bundle.out)).filter(filename => /^cleanup-results-.*-apply\.json$/.test(filename));
  assert.equal(archives.length, 1, 'Apply evidence remains archived even after later previews.');
  assert.equal(typeof report.volumeBefore[0].freeBytes, 'number');
  assert.equal(typeof report.volumeAfter[0].freeBytes, 'number');
  const repeat = await execute(bundle, true);
  assert.equal(repeat.exitCode, 2);
  assert.equal(repeat.report.targets[0].status, 'skipped');
  assert.match(repeat.report.targets[0].message, /absent/);
});

test('generation cannot overwrite, include its output, or accept missing targets', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: bundle.out }), /already exists/);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.target, 'bundle') }), /inside a cleanup target/);
  await fs.unlink(path.join(f.target, '文件 & % !.bin'));
  await fs.rmdir(f.target);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'missing') }), /not generated/);
});

test('invalid sealed shape stops before deletion and replaces latest result with archived fatal evidence', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  assert.equal((await execute(bundle)).exitCode, 0);
  const planPath = path.join(bundle.out, 'cleanup-plan.json');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  plan.targets[0].snapshot.files = -1;
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf8');
  const invalid = await execute(bundle, true);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.report.fatalError, /Invalid sealed snapshot count/);
  assert.equal(invalid.report.exitCode, 1);
  assert.ok(await fs.stat(f.target));
  const files = await fs.readdir(bundle.out);
  assert.ok(files.some(filename => /^cleanup-results-.*-fatal\.json$/.test(filename)));
  assert.ok(files.some(filename => /^cleanup-results-.*-preview\.json$/.test(filename)));
});

test('added source, changed file and deleted child invalidate the sealed target without deleting it', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  const file = path.join(f.target, '文件 & % !.bin');
  await fs.writeFile(path.join(f.target, 'new-source.cs'), 'new important source');
  const added = await execute(bundle, true);
  assert.equal(added.exitCode, 2);
  assert.equal(added.report.targets[0].status, 'failed');
  assert.match(added.report.targets[0].message, /changed/);
  await fs.unlink(path.join(f.target, 'new-source.cs'));
  await fs.writeFile(file, 'changed data');
  const changed = await execute(bundle, true);
  assert.equal(changed.exitCode, 2);
  assert.equal(await fs.readFile(file, 'utf8'), 'changed data');
  await fs.unlink(file);
  const removed = await execute(bundle, true);
  assert.equal(removed.exitCode, 2);
  assert.ok(await fs.stat(f.target));
});

test('outside/root/Git metadata/duplicate/overlap targets are rejected during sealing', { skip: !windows }, async t => {
  const f = await fixture(t);
  const manifest = path.join(f.parent, 'invalid.json');
  const outside = path.join(f.parent, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(f.root, '.git'));
  const cases = [
    { roots: [f.root], targets: [outside] },
    { roots: [f.root], targets: [f.root] },
    { roots: [path.parse(f.root).root], targets: [f.target] },
    { roots: [f.root], targets: [path.join(f.root, '.git')] },
    { roots: [f.root], targets: [f.target, f.target] },
    { roots: [f.root], targets: [f.target, f.target.toUpperCase()] },
    { roots: [f.root], targets: [f.target, path.join(f.target, '文件 & % !.bin')] },
    { roots: [f.root], targets: [path.join(f.target, '文件 & % !.bin'), f.target] },
  ];
  // Remove the fake marker before non-Git tests to avoid a broken-repository
  // rejection masking the path/overlap checks.
  await fs.rmdir(path.join(f.root, '.git'));
  for (let index = 0; index < cases.length; index += 1) {
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: cases[index].roots, targets: cases[index].targets.map(target => ({ path: target, reason: 'Test rejection' })) }));
    await assert.rejects(createCleanupBundle({ manifest, out: path.join(f.parent, `invalid-${index}`) }), index >= 4 ? /Duplicate or overlapping cleanup targets/ : /not generated/);
  }
  assert.ok(await fs.stat(f.target));
});

test('shape validation permits prefix-similar sibling targets at sealing and execution', { skip: !windows }, async t => {
  const f = await fixture(t);
  const siblings = [path.join(f.root, 'run'), path.join(f.root, 'run.old')];
  for (const directory of siblings) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'frame.bin'), 'separate reviewed fixture');
  }
  const manifest = path.join(f.parent, 'sibling-manifest.json');
  const out = path.join(f.parent, 'sibling-bundle');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root],
    targets: siblings.map(filename => ({ path: filename, reason: 'Independent reviewed sibling' })) }));
  const bundle = { ...await createCleanupBundle({ manifest, out }), manifest, out };
  const result = await execute(bundle);
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.report.targets.map(entry => entry.status), ['ready', 'ready']);
  assert.equal(result.report.removedLogicalBytes, 0);
  for (const directory of siblings) assert.equal(await fs.readFile(path.join(directory, 'frame.bin'), 'utf8'), 'separate reviewed fixture');
  assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain');
});

test('tracked files, nested repositories and new tracked ownership are protected', { skip: !windows }, async t => {
  const f = await fixture(t);
  await run('git', ['-C', f.root, 'init', '-q']);
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  await assert.rejects(generate(f), /tracked files/);
  await run('git', ['-C', f.root, 'rm', '--cached', '-r', '--', path.relative(f.root, f.target)]);
  const bundle = await generate(f);
  const unborn = await execute(bundle);
  assert.equal(unborn.exitCode, 0, unborn.output);
  assert.equal(unborn.report.targets[0].status, 'ready', 'A valid unborn branch can safely check an empty index.');
  assert.ok(await fs.stat(f.target), 'The unborn check is read-only.');
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  const tracked = await execute(bundle, true);
  assert.equal(tracked.exitCode, 2);
  assert.match(tracked.report.targets[0].message, /tracked files/);
  assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
  await run('git', ['-C', f.root, 'rm', '--cached', '-r', '--', path.relative(f.root, f.target)]);
  await fs.mkdir(path.join(f.target, 'nested'));
  await run('git', ['-C', path.join(f.target, 'nested'), 'init', '-q']);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'nested-repo-bundle') }), /nested repository/);
});

test('HEAD ownership protects staged deletions at sealing and after sealing', { skip: !windows }, async t => {
  const f = await fixture(t);
  await run('git', ['-C', f.root, 'init', '-q']);
  // This plan is safe to generate while the file has no Git ownership. Ownership
  // introduced later must be rechecked even when its index entry is removed.
  const bundle = await generate(f);
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  await run('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture source']);
  await run('git', ['-C', f.root, 'rm', '--cached', '-r', '--', path.relative(f.root, f.target)]);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'staged-deletion-bundle') }), /HEAD tracked files.*staged deletions/);
  const result = await execute(bundle, true);
  assert.equal(result.exitCode, 2, result.output);
  assert.match(result.report.targets[0].message, /HEAD tracked files.*staged deletions/);
  assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
});

test('combined Git query rechecks index additions with an existing HEAD', { skip: !windows }, async t => {
  const f = await fixture(t);
  await run('git', ['-C', f.root, 'init', '-q']);
  await run('git', ['-C', f.root, 'add', '--', 'keep-source.cs']);
  await run('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Existing HEAD']);
  const bundle = await generate(f);
  const initial = await execute(bundle);
  assert.equal(initial.exitCode, 0, initial.output);
  assert.equal(initial.report.targets[0].status, 'ready');
  // HEAD never contains this cache. Its newly added index ownership alone must
  // block the next execution; a HEAD-only query or stale result would delete it.
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  const result = await execute(bundle, true);
  assert.equal(result.exitCode, 2, result.output);
  assert.match(result.report.targets[0].message, /tracked files/);
  assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
  assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain');
});

test('failed combined Git query cannot treat corrupt HEAD ownership as an unborn branch', { skip: !windows }, async t => {
  for (const corruption of ['malformed-symbolic-branch', 'detached-missing-object', 'symbolic-nonbranch-head']) {
    const f = await fixture(t);
    await run('git', ['-C', f.root, 'init', '-q']);
    await run('git', ['-C', f.root, 'add', '--', 'keep-source.cs']);
    await run('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Existing HEAD']);
    const bundle = await generate(f);
    if (corruption === 'malformed-symbolic-branch') {
      const branch = (await run('git', ['-C', f.root, 'symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
      assert.match(branch, /^refs\/heads\//);
      await fs.writeFile(path.join(f.root, '.git', ...branch.split('/')), 'not-an-object-id\n');
    } else if (corruption === 'detached-missing-object') {
      await fs.writeFile(path.join(f.root, '.git', 'HEAD'), `${'1'.repeat(40)}\n`);
    } else {
      await fs.writeFile(path.join(f.root, '.git', 'HEAD'), 'ref: refs/tags/nonexistent\n');
    }
    // Both leave the target and index untouched. A general "HEAD failed, use
    // index" fallback would incorrectly approve this untracked target.
    const result = await execute(bundle, true);
    assert.equal(result.exitCode, 2, `${corruption}: ${result.output}`);
    assert.equal(result.report.targets[0].status, 'failed', corruption);
    assert.match(result.report.targets[0].message, /Git|HEAD|reference|object/i, corruption);
    assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data', corruption);
    assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain', corruption);
  }
});

test('bare and separate-git-dir storage are protected inside targets and their ancestors', { skip: !windows }, async t => {
  for (const kind of ['bare', 'separate']) {
    const f = await fixture(t);
    const storage = path.join(f.target, 'repository-state');
    if (kind === 'bare') await run('git', ['init', '-q', '--bare', storage]);
    else await run('git', ['-C', f.root, 'init', '-q', '--separate-git-dir', storage]);
    // The normal target is an ordinary directory containing Git metadata under
    // a name that does not contain .git. Its subtree scan must catch the storage.
    await assert.rejects(generate(f), /Git repository storage in target subtree/);
    // A target deep inside the object store must be rejected by its ancestors,
    // even though it contains no HEAD/.git marker itself.
    const manifest = path.join(f.parent, 'git-storage-manifest.json');
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root], targets: [
      { path: path.join(storage, 'objects', 'info'), reason: 'Must be refused' },
    ] }));
    await assert.rejects(createCleanupBundle({ manifest, out: path.join(f.parent, 'git-storage-bundle') }), /Git repository storage in target or ancestor/);
    assert.ok(await fs.stat(path.join(storage, 'HEAD')));
  }
});

test('linked-worktree admin storage cannot be hidden under an ordinary cache name', { skip: !windows }, async t => {
  const f = await fixture(t);
  const admin = path.join(f.target, 'worktree-admin');
  await fs.mkdir(admin);
  await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(admin, 'commondir'), '../../shared-storage\n');
  await fs.writeFile(path.join(admin, 'gitdir'), path.join(f.root, 'worktree', '.git'));
  await assert.rejects(generate(f), /Git repository storage in target subtree/);
  assert.ok(await fs.stat(admin));
});

test('subtree/ancestor junctions are rejected without touching their destination', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  const outside = path.join(f.parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'important.cs'), 'external source');
  await fs.symlink(outside, path.join(f.target, 'link'), 'junction');
  const changed = await execute(bundle, true);
  assert.equal(changed.exitCode, 2);
  assert.match(changed.report.targets[0].message, /Reparse point/);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'linked-bundle') }), /Reparse point/);
  assert.equal(await fs.readFile(path.join(outside, 'important.cs'), 'utf8'), 'external source');
  await fs.unlink(path.join(f.target, 'link'));
  await fs.rename(f.target, path.join(f.root, 'original-cache'));
  await fs.symlink(outside, f.target, 'junction');
  const replaced = await execute(bundle, true);
  assert.equal(replaced.exitCode, 2);
  assert.match(replaced.report.targets[0].message, /Reparse point/);
  assert.equal(await fs.readFile(path.join(outside, 'important.cs'), 'utf8'), 'external source');
});

test('active project guards skip only their item and do not expose process command lines', { skip: !windows }, async t => {
  const f = await fixture(t);
  const sleeper = path.join(f.parent, 'guard-fixture.ps1');
  await fs.writeFile(sleeper, 'param([string] $projectPath)\r\nStart-Sleep -Seconds 120\r\n', 'ascii');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sleeper, '-projectPath', f.root], { windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  const bundle = await generate(f, { processGuards: [{ processName: 'powershell.exe', projectRoot: f.root }] });
  const active = await execute(bundle, true);
  assert.equal(active.exitCode, 2, active.output);
  assert.equal(active.report.targets[0].status, 'skipped', active.output);
  assert.match(active.report.targets[0].message, /guarded process is active|ownership unavailable|no readable projectPath/);
  assert.ok(!active.output.includes('Start-Sleep'));
  assert.ok(await fs.stat(f.target));
});

test('executable-root guard affects only its item; a separate sealed file target is deleted', { skip: !windows }, async t => {
  const f = await fixture(t);
  const runner = path.join(f.root, 'runner');
  await fs.mkdir(runner);
  const copiedCmd = path.join(runner, 'cmd.exe');
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), copiedCmd);
  const child = spawn(copiedCmd, ['/d', '/k'], { windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    const file = path.join(f.root, 'duplicate % !.zip');
    await fs.writeFile(file, 'disposable zip');
    const manifest = path.join(f.parent, 'guard-manifest.json');
    const out = path.join(f.parent, 'guard-bundle');
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root.replaceAll('\\', '/')], targets: [
      { path: f.target, reason: 'Guarded cache', processGuards: [{ processName: 'cmd.exe', executableRoot: runner }] },
      { path: file, reason: 'Reviewed disposable file' },
    ] }));
    await createCleanupBundle({ manifest, out });
    const result = await execute({ out }, true);
    assert.equal(result.exitCode, 2, result.output);
    assert.equal(result.report.targets[0].status, 'skipped', result.output);
    assert.equal(result.report.targets[1].status, 'deleted', result.output);
    assert.equal(result.report.removedLogicalBytes, 14);
    assert.ok(await fs.stat(f.target));
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
});

test('external process ownership guards block active workers without extending deletion roots', { skip: !windows }, async t => {
  for (const field of ['projectRoot', 'executableRoot']) {
    const f = await fixture(t);
    const external = path.join(f.parent, 'external worker');
    await fs.mkdir(external);
    const externalFile = path.join(external, 'important-source.cs');
    await fs.writeFile(externalFile, 'outside deletion authority');
    const processName = `fws-clear-${field}-${process.pid}.exe`;
    const executable = path.join(external, processName);
    await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), executable);
    // A private cmd copy stays idle after REM; its command line also supplies
    // a real, quoted projectPath without starting or touching any Unity worker.
    const child = spawn(executable, ['/d', '/k', 'rem', '-projectPath', external], { windowsHide: true });
    await once(child, 'spawn');
    try {
      const guard = { processName, [field]: external.replaceAll('\\', '/') };
      const bundle = await generate(f, { processGuards: [guard] });
      const plan = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-plan.json'), 'utf8'));
      assert.deepEqual(plan.roots, [f.root]);
      assert.equal(plan.targets[0].processGuards[0][field], external);
      const blocked = await execute(bundle, true);
      assert.equal(blocked.exitCode, 2, blocked.output);
      assert.equal(blocked.report.targets[0].status, 'skipped', blocked.output);
      assert.match(blocked.report.targets[0].message, /matching guarded process is active/i);
      assert.ok(await fs.stat(f.target));
      assert.equal(await fs.readFile(externalFile, 'utf8'), 'outside deletion authority');

      const invalidManifest = path.join(f.parent, 'outside-target.json');
      await fs.writeFile(invalidManifest, JSON.stringify({ schemaVersion: 1, roots: [f.root], targets: [
        { path: externalFile, reason: 'Must remain outside authority', processGuards: [guard] },
      ] }));
      await assert.rejects(createCleanupBundle({ manifest: invalidManifest, out: path.join(f.parent, 'outside-target-bundle') }), /strictly inside an authorized root/);

      const closed = once(child, 'close');
      child.kill();
      await closed;
      const applied = await execute(bundle, true);
      assert.equal(applied.exitCode, 0, applied.output);
      assert.equal(applied.report.targets[0].status, 'deleted', applied.output);
      assert.equal(await fs.readFile(externalFile, 'utf8'), 'outside deletion authority');
      assert.ok(await fs.stat(executable));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    }
  }
});

test('multiple live guards with dotted process names remain protected until every owning worker exits', { skip: !windows }, async t => {
  const f = await fixture(t), workers = [];
  const stop = async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const directory = path.join(f.parent, `worker-${index}`);
      await fs.mkdir(directory);
      const processName = `fws.clear.worker${index}-${process.pid}.exe`;
      const executable = path.join(directory, processName);
      await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), executable);
      const child = spawn(executable, ['/d', '/k', 'rem', '-projectPath', directory], { windowsHide: true });
      workers.push({ child, directory, processName });
      await once(child, 'spawn');
    }
    const bundle = await generate(f, { processGuards: [
      { processName: workers[0].processName, executableRoot: workers[0].directory },
      { processName: workers[1].processName.replace(/\.exe$/i, ''), projectRoot: workers[1].directory },
    ] });
    const bothActive = await execute(bundle, true);
    assert.equal(bothActive.exitCode, 2, bothActive.output);
    assert.equal(bothActive.report.targets[0].status, 'skipped');
    assert.match(bothActive.report.targets[0].message, /matching guarded process is active/i);
    assert.ok(await fs.stat(f.target));
    // An empty first guard cannot short-circuit the second live owner; dots in
    // its executable name must survive the inexpensive native name filter.
    await stop(workers[0].child);
    const secondActive = await execute(bundle, true);
    assert.equal(secondActive.exitCode, 2, secondActive.output);
    assert.equal(secondActive.report.targets[0].status, 'skipped');
    assert.match(secondActive.report.targets[0].message, /matching guarded process is active/i);
    assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
    await stop(workers[1].child);
    const inactive = await execute(bundle, true);
    assert.equal(inactive.exitCode, 0, inactive.output);
    assert.equal(inactive.report.targets[0].status, 'deleted');
    assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain');
  } finally {
    for (const worker of workers) await stop(worker.child);
  }
});

test('guard retains a target when CIM omits a helper discovered alive by its process name', { skip: !windows }, async t => {
  const f = await fixture(t);
  const workerRoot = path.join(f.parent, 'worker');
  await fs.mkdir(workerRoot);
  const processName = `fws.provider.fixture-${process.pid}.exe`;
  const executable = path.join(workerRoot, processName);
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), executable);
  const child = spawn(executable, ['/d', '/k'], { windowsHide: true });
  await once(child, 'spawn');
  try {
    const bundle = await generate(f, { processGuards: [{ processName, executableRoot: workerRoot }] });
    const provider = path.join(f.parent, 'empty-provider.ps1');
    const seenFilter = path.join(f.parent, 'provider-filter.txt');
    await fs.writeFile(provider, `param([string] $Executor, [string] $Plan, [string] $SeenFilter)
$global:FwsFixtureFilterPath = $SeenFilter
function Get-CimInstance {
  param([string] $ClassName, [string] $Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected provider request.' }
  [IO.File]::WriteAllText($global:FwsFixtureFilterPath, $Filter)
  return @()
}
& $Executor -PlanPath $Plan -Apply
exit $LASTEXITCODE
`, 'utf8');
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', provider,
      '-Executor', path.join(bundle.out, 'execute-cleanup.ps1'), '-Plan', path.join(bundle.out, 'cleanup-plan.json'), '-SeenFilter', seenFilter],
    { windowsHide: true }).then(r => ({ exitCode: 0, output: r.stdout + r.stderr }), e => ({ exitCode: e.code, output: e.stdout + e.stderr }));
    const report = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8'));
    assert.equal(result.exitCode, 2, result.output);
    assert.equal(report.targets[0].status, 'skipped', result.output);
    assert.match(report.targets[0].message, /ownership|snapshot|retained/i);
    assert.match(await fs.readFile(seenFilter, 'utf8'), new RegExp(`ProcessId\\s*=\\s*${child.pid}(?:\\s|$)`),
      'The real helper must have been found before the provider deliberately omitted it.');
    assert.equal(child.exitCode, null, 'The helper is still alive; missing CIM data is not evidence of exit.');
    assert.equal(report.removedLogicalBytes, 0);
    assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  }
});

test('external guard paths still reject relative, redirected namespace and ambiguous spellings', { skip: !windows }, async t => {
  const f = await fixture(t);
  for (const [field, value, message] of [
    ['projectRoot', 'relative-worker', /absolute local drive path/],
    ['executableRoot', path.join(f.parent, 'worker*'), /Ambiguous or wildcard|GetFullPath/],
    ['projectRoot', '\\\\server\\worker', /absolute local drive path/],
    ['executableRoot', `${f.parent}:stream`, /alternate streams/],
  ]) {
    await assert.rejects(generate(f, { processGuards: [{ processName: 'Unity.exe', [field]: value }] }), message);
  }
  assert.equal(await fs.readFile(path.join(f.target, '文件 & % !.bin'), 'utf8'), 'fixture data');
});
