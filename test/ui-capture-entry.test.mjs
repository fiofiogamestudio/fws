import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../skills/fw-ui-capture/scripts/ui-capture.mjs', import.meta.url));
const legacy = fileURLToPath(new URL('../skills/fw-ui-capture/scripts/build-gallery.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-ui-entry with spaces-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fws-ui-entry with spaces-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const fwv = path.join(root, 'fwv');
  await fs.mkdir(path.join(fwv, 'ui'), { recursive: true });
  await fs.writeFile(path.join(fwv, 'package.json'), JSON.stringify({ name: 'fwv', type: 'module' }));
  await fs.writeFile(path.join(fwv, 'ui/cli.mjs'), `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = 7;`);
  return { root, fwv };
}

function run(script, args, { fwHome, cwd } = {}) {
  const env = { ...process.env };
  delete env.FW_HOME;
  if (fwHome !== undefined) env.FW_HOME = fwHome;
  return spawnSync(process.execPath, [script, ...args], { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

async function installWrapper(directory) {
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await fs.copyFile(entry, path.join(directory, 'scripts/ui-capture.mjs'));
  await fs.copyFile(legacy, path.join(directory, 'scripts/build-gallery.mjs'));
  return path.join(directory, 'scripts/ui-capture.mjs');
}

test('explicit workspace wins over environment, keeps host cwd and forwards CLI values and exit status', async t => {
  const f = await fixture(t);
  const args = ['serve', '--manifest', 'input with spaces/capture.json', '--fwe-path', path.join(f.root, 'FWE with spaces'), '--port', '0', '--open'];
  const result = run(entry, [...args, '--fw-root', f.root], { fwHome: path.join(f.root, 'wrong'), cwd: f.root });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: f.root });
});

test('FW_HOME supplies the workspace and export does not require FWE', async t => {
  const f = await fixture(t);
  const args = ['export', '--manifest', 'capture.json', '--out', 'new gallery'];
  const result = run(entry, args, { fwHome: f.root });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, args);
  await assert.rejects(fs.stat(path.join(f.root, 'fwe')), { code: 'ENOENT' });
});

test('verified FW program root locates sibling FWV, via explicit option or FW_HOME', async t => {
  const f = await fixture(t), program = path.join(f.root, 'fw');
  await fs.mkdir(program);
  await fs.writeFile(path.join(program, 'package.json'), JSON.stringify({ name: 'fw', fwWorkspace: true }));
  for (const [args, environment] of [
    [['validate', '--manifest', 'capture.json', '--fw-root', program], {}],
    [['validate', '--manifest', 'capture.json'], { fwHome: program }],
  ]) assert.equal(run(entry, args, environment).status, 7);
  await fs.writeFile(path.join(program, 'package.json'), JSON.stringify({ name: 'fw', fwWorkspace: 'true' }));
  const result = run(entry, ['validate', '--manifest', 'capture.json', '--fw-root', program], { fwHome: f.root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found or verified from --fw-root/);
});

test('physical FWS source and installed junction locate the same sibling FWV without environment', async t => {
  const f = await fixture(t), source = path.join(f.root, 'fws/skills/fw-ui-capture');
  const copied = await installWrapper(source);
  assert.equal(run(copied, ['validate', '--manifest', 'capture.json']).status, 7);
  const linked = path.join(f.root, 'installed skill');
  await fs.symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(path.join(linked, 'scripts/ui-capture.mjs'), ['validate', '--manifest', 'capture.json']);
  assert.equal(result.status, 7, result.stderr);
});

test('invalid explicit root does not fall back to a valid FW_HOME or create missing files', async t => {
  const f = await fixture(t), absent = path.join(f.root, 'absent');
  const result = run(entry, ['validate', '--manifest', 'capture.json', '--fw-root', absent], { fwHome: f.root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found or verified from --fw-root/);
  assert.match(result.stderr, /no automatic install/);
  assert.equal(result.stdout, '');
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});

test('invalid FW_HOME does not fall back to an otherwise valid physical workspace', async t => {
  const f = await fixture(t), copied = await installWrapper(path.join(f.root, 'fws/skills/fw-ui-capture'));
  const result = run(copied, ['validate', '--manifest', 'capture.json'], { fwHome: path.join(f.root, 'absent') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found or verified from FW_HOME/);
  assert.equal(result.stdout, '');
});

test('wrong FWV identity or missing/non-file UI entry fails before executing backend code', async t => {
  const f = await fixture(t), cli = path.join(f.fwv, 'ui/cli.mjs');
  for (const name of ['fwd', 'fwe', 'fw']) {
    await fs.writeFile(path.join(f.fwv, 'package.json'), JSON.stringify({ name }));
    const result = run(entry, ['validate', '--manifest', 'capture.json', '--fw-root', f.root]);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /name=fwv/);
  }
  await fs.writeFile(path.join(f.fwv, 'package.json'), JSON.stringify({ name: 'fwv' }));
  await fs.unlink(cli);
  assert.equal(run(entry, ['validate', '--manifest', 'capture.json', '--fw-root', f.root]).status, 1);
  await fs.mkdir(cli);
  assert.equal(run(entry, ['validate', '--manifest', 'capture.json', '--fw-root', f.root]).status, 1);
});

test('copied standalone skill requires an explicit backend and does not search the host cwd', async t => {
  const f = await fixture(t), copied = await installWrapper(path.join(f.root, 'detached/client/skills/fw-ui-capture'));
  const result = run(copied, ['validate', '--manifest', 'capture.json'], { cwd: f.root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /physical FWS location/);
  assert.equal(result.stdout, '');
});

test('legacy build-gallery only forwards export to the selected FWV backend', async t => {
  const f = await fixture(t);
  const args = ['--manifest', 'capture.json', '--out', 'gallery with spaces'];
  const result = run(legacy, [...args, '--fw-root', f.root]);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ['export', ...args]);
});

test('help needs no backend; malformed wrapper options fail instead of guessing', async t => {
  const f = await fixture(t);
  const help = run(entry, ['--help'], { fwHome: path.join(f.root, 'absent') });
  assert.equal(help.status, 0); assert.match(help.stdout, /serve\|validate\|export/);
  for (const args of [
    ['unknown'],
    ['validate', '--fw-root'],
    ['validate', '--fw-root', ''],
    ['validate', '--fw-root', f.root, '--fw-root', f.root],
  ]) {
    const result = run(entry, args, { fwHome: f.root });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
});
