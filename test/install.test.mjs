import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installSkills, parseInstallArgs } from '../tools/install.mjs';

async function skill(directory, name, content = '') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill.\n---\n${content}\n`);
}

async function fixture(t, entries = [{ name: 'fw-one', legacyNames: ['old-one'] }, { name: 'fw-two', legacyNames: [] }]) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-install-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, 'source');
  const target = path.join(temporary, 'skills');
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'catalog.json'), JSON.stringify({ schemaVersion: 1, skills: entries }));
  for (const entry of entries) await skill(path.join(sourceRoot, 'skills', entry.name), entry.name, 'Canonical content.');
  return { temporary, sourceRoot, target };
}

async function snapshot(directory) {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    result[entry.name] = entry.isSymbolicLink() ? { link: await fs.readlink(filename) } : entry.isDirectory() ? await snapshot(filename) : { bytes: (await fs.readFile(filename)).toString('base64') };
  }
  return result;
}

test('preview is the default and performs zero writes, including a missing target', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.temporary);
  const io = { ...fs };
  let attemptedWrites = 0;
  for (const operation of ['mkdir', 'open', 'rename', 'symlink', 'writeFile', 'rmdir', 'unlink']) io[operation] = () => { attemptedWrites++; throw new Error(`Unexpected preview write: ${operation}`); };
  const result = await installSkills(options, io);
  assert.equal(attemptedWrites, 0);
  assert.equal(result.mode, 'preview');
  assert.deepEqual(result.changes, { links: 2, backups: 0 });
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('apply creates canonical directory links; repeat is idempotent and preserves unrelated skills', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, '.system', 'official'), 'official', 'Untouched.');
  await skill(path.join(options.target, 'unrelated'), 'unrelated', 'Untouched.');
  const first = await installSkills({ ...options, apply: true });
  assert.equal(first.changes.links, 2);
  assert.equal((await fs.lstat(path.join(options.target, 'fw-one'))).isSymbolicLink(), true);
  assert.equal(await fs.realpath(path.join(options.target, 'fw-one')), await fs.realpath(path.join(options.sourceRoot, 'skills', 'fw-one')));
  assert.match(await fs.readFile(path.join(options.target, 'fw-one', 'SKILL.md'), 'utf8'), /Canonical content/);
  const before = await snapshot(options.temporary);
  const second = await installSkills({ ...options, apply: true });
  assert.deepEqual(second.changes, { links: 0, backups: 0 });
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('migration requires explicit authorization and preserves every original byte outside discovery root', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one', 'Custom legacy changes.');
  await skill(path.join(options.target, 'fw-two'), 'fw-two', 'Custom current-name changes.');
  await fs.mkdir(path.join(options.target, 'old-one', 'nested'));
  await fs.writeFile(path.join(options.target, 'old-one', 'nested', 'binary.dat'), Buffer.from([0, 255, 19]));
  const legacy = await snapshot(path.join(options.target, 'old-one'));
  const sameName = await snapshot(path.join(options.target, 'fw-two'));
  const before = await snapshot(options.temporary);
  await assert.rejects(installSkills({ ...options, apply: true }), { code: 'migration-required' });
  assert.deepEqual(await snapshot(options.temporary), before);
  const preview = await installSkills({ ...options, migrateLegacy: true });
  assert.equal(preview.changes.backups, 2);
  assert.deepEqual(await snapshot(options.temporary), before);
  const result = await installSkills({ ...options, apply: true, migrateLegacy: true });
  assert.equal(path.dirname(result.backupRoot), path.dirname(options.target));
  assert.notEqual(path.dirname(result.backupRoot), options.target);
  assert.deepEqual(await snapshot(path.join(result.backupRoot, 'old-one')), legacy);
  assert.deepEqual(await snapshot(path.join(result.backupRoot, 'fw-two')), sameName);
  await assert.rejects(fs.lstat(path.join(options.target, 'old-one')), { code: 'ENOENT' });
  assert.equal((await fs.lstat(path.join(options.target, 'fw-one'))).isSymbolicLink(), true);
});

test('unknown same-name identity rejects the whole plan before any writes', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one');
  await skill(path.join(options.target, 'fw-two'), 'not-fw-two', 'Unknown content.');
  const before = await snapshot(options.temporary);
  const io = { ...fs };
  let attemptedWrites = 0;
  for (const operation of ['mkdir', 'open', 'rename', 'symlink', 'writeFile', 'rmdir', 'unlink']) io[operation] = () => { attemptedWrites++; throw new Error(`Unexpected conflict write: ${operation}`); };
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }, io), { code: 'identity-mismatch' });
  assert.equal(attemptedWrites, 0);
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('an unidentified directory and a regular file are retained, even with migration enabled', async t => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.target, 'fw-one'), { recursive: true });
  await fs.writeFile(path.join(options.target, 'fw-one', 'notes.txt'), 'Keep me.');
  const before = await snapshot(options.temporary);
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }), { code: 'unknown-content' });
  assert.deepEqual(await snapshot(options.temporary), before);
  await fs.rename(path.join(options.target, 'fw-one'), path.join(options.target, 'retained'));
  await fs.writeFile(path.join(options.target, 'fw-one'), 'Keep this too.');
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }), { code: 'conflict' });
  assert.equal(await fs.readFile(path.join(options.target, 'fw-one'), 'utf8'), 'Keep this too.');
});

test('failure during link creation restores all backups and removes only this run links', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one', 'Preserve the complete old tree.');
  await skill(path.join(options.target, 'fw-two'), 'fw-two', 'Preserve current-name content.');
  await skill(path.join(options.target, 'unrelated'), 'unrelated');
  const before = await snapshot(options.temporary);
  let attempts = 0;
  const io = { ...fs, symlink: async (...args) => { if (++attempts === 2) throw new Error('Injected second-link failure'); return fs.symlink(...args); } };
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }, io), error => {
    assert.match(error.message, /Injected/);
    assert.equal(error.details.rollbackComplete, true);
    return true;
  });
  assert.equal(attempts, 2);
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('failure during fresh installation removes the new empty target', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.temporary);
  const io = { ...fs, symlink: async () => { throw new Error('Injected link failure'); } };
  await assert.rejects(installSkills({ ...options, apply: true }, io), /Injected/);
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('backup notification occurs after complete backup and before links', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one', 'Original data.');
  let observed = false;
  await installSkills({ ...options, apply: true, migrateLegacy: true, onBackup: async event => {
    observed = true;
    assert.equal(event.event, 'backup-created');
    assert.match(await fs.readFile(path.join(event.path, 'old-one', 'SKILL.md'), 'utf8'), /Original data/);
    await assert.rejects(fs.lstat(path.join(options.target, 'old-one')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(options.target, 'fw-one')), { code: 'ENOENT' });
  } });
  assert.equal(observed, true);
});

test('failure on a later backup restores an earlier moved directory', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one', 'One.');
  await skill(path.join(options.target, 'fw-two'), 'fw-two', 'Two.');
  const before = await snapshot(options.temporary);
  let renames = 0;
  const io = { ...fs, rename: async (...args) => { if (++renames === 2) throw new Error('Injected second-backup failure'); return fs.rename(...args); } };
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }, io), error => {
    assert.equal(error.details.rollbackComplete, true);
    return error.message.includes('second-backup');
  });
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('cooperative lock prevents concurrent installers from mutating the same target', async t => {
  const options = await fixture(t);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const io = { ...fs, symlink: async (...args) => { entered(); await gate; return fs.symlink(...args); } };
  const first = installSkills({ ...options, apply: true }, io);
  await started;
  try { await assert.rejects(installSkills({ ...options, apply: true }), { code: 'install-locked' }); }
  finally { release(); }
  assert.equal((await first).ok, true);
  assert.equal((await installSkills({ ...options, apply: true })).changes.links, 0);
});

test('an existing interrupted-install lock is retained and requires operator review', async t => {
  const options = await fixture(t);
  const lock = path.join(options.temporary, '.skills.fws-install.lock');
  await fs.writeFile(lock, 'previous-owner');
  const before = await snapshot(options.temporary);
  await assert.rejects(installSkills({ ...options, apply: true }), { code: 'install-locked' });
  assert.deepEqual(await snapshot(options.temporary), before);
});

test('rollback never overwrites a concurrently created path and retains its backup', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one', 'Original data.');
  const io = { ...fs, symlink: async () => {
    await skill(path.join(options.target, 'old-one'), 'new-owner', 'Concurrent data.');
    throw new Error('Injected concurrent replacement');
  } };
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }, io), error => {
    assert.equal(error.details.rollbackComplete, false);
    return error.message.includes('Injected');
  });
  const backup = (await fs.readdir(options.temporary)).find(name => name.startsWith('skills.fws-backup-'));
  assert.ok(backup);
  assert.match(await fs.readFile(path.join(options.temporary, backup, 'old-one', 'SKILL.md'), 'utf8'), /Original data/);
  assert.match(await fs.readFile(path.join(options.target, 'old-one', 'SKILL.md'), 'utf8'), /Concurrent data/);
});

test('explicit selection installs only selected canonical skills, preserving unrelated legacy paths', async t => {
  const options = await fixture(t);
  await skill(path.join(options.target, 'old-one'), 'old-one');
  const result = await installSkills({ ...options, skills: ['fw-two'], apply: true });
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'fw-two');
  assert.equal((await fs.lstat(path.join(options.target, 'old-one'))).isDirectory(), true);
  await assert.rejects(fs.lstat(path.join(options.target, 'fw-one')), { code: 'ENOENT' });
  await assert.rejects(installSkills({ ...options, skills: ['old-one'] }), { code: 'unknown-skill' });
});

test('source/target overlap, traversal, protected and redirected targets are rejected', async t => {
  const options = await fixture(t);
  for (const target of [options.sourceRoot, path.join(options.sourceRoot, 'destination'), options.temporary]) {
    await assert.rejects(installSkills({ ...options, target, apply: true }), { code: 'overlapping-paths' });
  }
  await assert.rejects(installSkills({ ...options, target: path.join(options.temporary, 'x') + '/../skills' }), { code: 'unsafe-target' });
  await assert.rejects(installSkills({ ...options, target: path.join(options.temporary, '.system') }), { code: 'protected-target' });
  const outside = path.join(options.temporary, 'other');
  await fs.mkdir(outside);
  await fs.symlink(outside, options.target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkills({ ...options, apply: true }), { code: 'unsafe-target' });
  await assert.rejects(installSkills({ ...options, target: path.join(options.target, 'nested') }), { code: 'unsafe-target' });
});

test('existing foreign and broken junctions are not followed or migrated', async t => {
  const options = await fixture(t);
  await fs.mkdir(options.target);
  const other = path.join(options.temporary, 'other');
  await skill(other, 'fw-one');
  await fs.symlink(other, path.join(options.target, 'fw-one'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }), { code: 'abnormal-link' });
  assert.match(await fs.readFile(path.join(other, 'SKILL.md'), 'utf8'), /fw-one/);
  await fs.rename(other, path.join(options.temporary, 'moved'));
  await assert.rejects(installSkills({ ...options, apply: true, migrateLegacy: true }), { code: 'abnormal-link' });
});

test('bad catalog cannot inject traversal or alias collisions', async t => {
  const options = await fixture(t);
  for (const skills of [[{ name: '../outside', legacyNames: [] }], [{ name: 'fw-one', legacyNames: ['fw-two'] }, { name: 'fw-two', legacyNames: [] }]]) {
    await fs.writeFile(path.join(options.sourceRoot, 'catalog.json'), JSON.stringify({ schemaVersion: 1, skills }));
    await assert.rejects(installSkills({ ...options, apply: true }), { code: 'invalid-catalog' });
    await assert.rejects(fs.lstat(options.target), { code: 'ENOENT' });
  }
});

test('CLI parser requires target, rejects unknown/duplicate switches, supports repeated selection', () => {
  assert.deepEqual(parseInstallArgs(['--target', 'somewhere', '--skill', 'fw-one', '--skill', 'fw-two', '--apply', '--migrate-legacy']), { target: 'somewhere', skills: ['fw-one', 'fw-two'], apply: true, migrateLegacy: true });
  assert.throws(() => parseInstallArgs([]), { code: 'target-required' });
  assert.throws(() => parseInstallArgs(['--target', 'x', '--force']), { code: 'invalid-arguments' });
  assert.throws(() => parseInstallArgs(['--target', 'x', '--target', 'y']), { code: 'invalid-arguments' });
});
