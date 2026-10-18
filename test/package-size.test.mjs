import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { auditPackage, main } from '../skills/fw-package-size/scripts/audit-package.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-package-size-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Minimal ZIP writer for controlled stored/deflated metadata fixtures. The audit
// intentionally does not validate payload CRC; a zero CRC is adequate here.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, content = '', mode = 0, method = 8, descriptor = false } of entries) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(content);
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800 | (descriptor ? 8 : 0), 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(descriptor ? 0 : payload.length, 18);
    header.writeUInt32LE(descriptor ? 0 : raw.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, payload);
    const trailer = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(payload.length, 8);
      trailer.writeUInt32LE(raw.length, 12);
      local.push(trailer);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800 | (descriptor ? 8 : 0), 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + payload.length + trailer.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('directory measures logical bytes and hashes, keeps inputs unchanged, and compares content changes', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'build');
  await fs.mkdir(path.join(input, 'assets'), { recursive: true });
  await fs.writeFile(path.join(input, 'index.html'), 'abc');
  await fs.writeFile(path.join(input, 'assets', 'game.bin'), Buffer.alloc(100, 1));
  const before = await auditPackage({ input, top: 1 });
  assert.equal(before.expandedBytes, 103);
  assert.equal(before.maxFileBytes, 100);
  assert.equal(before.topExpanded[0].path, 'assets/game.bin');
  assert.equal(before.items.find(item => item.path === 'index.html').sha256, createHash('sha256').update('abc').digest('hex'));
  assert.deepEqual(await fs.readdir(input), ['assets', 'index.html']);
  await fs.writeFile(path.join(input, 'assets', 'game.bin'), Buffer.alloc(50));
  await fs.writeFile(path.join(input, 'index.html'), 'xyz');
  const after = await auditPackage({ input, baseline: before });
  assert.equal(after.comparison.totals.expandedBytes.savedBytes, 50);
  assert.equal(after.comparison.changes.length, 2);
  assert.equal(after.comparison.changes.find(item => item.path === 'index.html').savedBytes, 0);
});

test('ZIP separates archive, compressed payload and expanded bytes without extraction', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'game.zip');
  const content = zip([{ name: 'index.html', content: 'hello', method: 0 }, { name: '素材/data.bin', content: 'a'.repeat(1000) }]);
  await fs.writeFile(input, content);
  const report = await auditPackage({ input });
  assert.equal(report.archiveBytes, content.length);
  assert.equal(report.archiveSha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(report.expandedBytes, 1005);
  assert.equal(report.compressedPayloadBytes, 5 + deflateRawSync(Buffer.from('a'.repeat(1000))).length);
  assert.equal(report.archiveOverheadBytes, content.length - report.compressedPayloadBytes);
  assert.equal(report.fileCount, 2);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(await fs.readdir(root), ['game.zip']);
  assert.deepEqual(await fs.readFile(input), content);
});

test('ZIP flags traversal, absolute paths, duplicate paths and symlinks without writing them', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'unsafe.zip');
  await fs.writeFile(input, zip([{ name: '../escape.txt' }, { name: 'C:\\escape.txt' }, { name: '/root.txt' }, { name: 'same' }, { name: 'same' }, { name: 'link', mode: 0xa1ff }]));
  const report = await auditPackage({ input });
  assert.equal(report.issues.filter(item => item.issue === 'unsafe-path').length, 3);
  assert.ok(report.issues.some(item => item.issue === 'duplicate-path'));
  assert.ok(report.issues.some(item => item.issue === 'symbolic-link'));
  assert.deepEqual(await fs.readdir(root), ['unsafe.zip']);
  await assert.rejects(auditPackage({ input, baseline: report }), /duplicate item paths/);
});

test('malformed, ZIP64 and split archives fail explicitly', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'bad.zip');
  await fs.writeFile(input, Buffer.from('not a zip'));
  await assert.rejects(auditPackage({ input }), /end record/);
  const zip64 = zip([]);
  zip64.writeUInt16LE(0xffff, 10);
  await fs.writeFile(input, zip64);
  await assert.rejects(auditPackage({ input }), /ZIP64/);
  const split = zip([]);
  split.writeUInt16LE(1, 4);
  await fs.writeFile(input, split);
  await assert.rejects(auditPackage({ input }), /Split ZIP/);
});

test('ZIP validates physical payload ranges and metadata while accepting data descriptors', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'range.zip');
  const impossible = zip([{ name: 'payload.txt', content: 'x', method: 0 }]);
  const centralOffset = impossible.readUInt32LE(impossible.length - 6);
  impossible.writeUInt32LE(1048576, centralOffset + 20);
  impossible.writeUInt32LE(1048576, centralOffset + 24);
  await fs.writeFile(input, impossible);
  await assert.rejects(auditPackage({ input }), /payload exceeds/);
  const mismatch = zip([{ name: 'payload.txt', content: 'x', method: 0 }]);
  mismatch.writeUInt32LE(2, 22);
  await fs.writeFile(input, mismatch);
  await assert.rejects(auditPackage({ input }), /local and central sizes/);
  await fs.writeFile(input, zip([{ name: 'payload.txt', content: 'x', descriptor: true }]));
  const streamed = await auditPackage({ input });
  assert.equal(streamed.expandedBytes, 1);
  assert.ok(streamed.archiveOverheadBytes > 0);
  assert.deepEqual(streamed.issues, []);
});

test('ZIP canonical aliases are collisions and cannot produce ambiguous comparisons', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'aliases.zip');
  await fs.writeFile(input, zip([{ name: 'payload.txt', content: 'x' }, { name: './payload.txt', content: 'y' }, { name: 'dir//item.txt' }, { name: 'dir/item.txt' }]));
  const report = await auditPackage({ input });
  assert.deepEqual(report.issues.filter(item => item.issue === 'duplicate-path').map(item => item.path), ['./payload.txt', 'dir/item.txt']);
  await assert.rejects(auditPackage({ input, baseline: report }), /duplicate item paths/);
});

test('baseline summaries must agree with item sizes before calculating savings', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'build');
  await fs.mkdir(input);
  await fs.writeFile(path.join(input, 'payload.txt'), 'x');
  const baseline = await auditPackage({ input });
  await assert.rejects(auditPackage({ input, baseline: { ...baseline, expandedBytes: 1048576 } }), /expandedBytes disagrees/);
  await assert.rejects(auditPackage({ input, baseline: { ...baseline, fileCount: 2 } }), /fileCount disagrees/);
  await assert.rejects(auditPackage({ input, baseline: { ...baseline, maxFileBytes: 2 } }), /maxFileBytes disagrees/);
  await assert.rejects(auditPackage({ input, baseline: { ...baseline, items: [{ ...baseline.items[0], bytes: -1 }] } }), /Invalid baseline item bytes/);
  const zipInput = path.join(root, 'build.zip');
  await fs.writeFile(zipInput, zip([{ name: 'payload.txt', content: 'x' }]));
  const zipBaseline = await auditPackage({ input: zipInput });
  await assert.rejects(auditPackage({ input: zipInput, baseline: { ...zipBaseline, compressedPayloadBytes: 1048576 } }), /compressedPayloadBytes disagrees/);
  await assert.rejects(auditPackage({ input: zipInput, baseline: { ...zipBaseline, archiveBytes: 1 } }), /archive size\/overhead/);
  assert.equal((await auditPackage({ input, baseline })).comparison.totals.expandedBytes.savedBytes, 0);
});

test('directory audit refuses linked content and output cannot enter input or overwrite an existing report', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'build');
  const elsewhere = path.join(root, 'elsewhere');
  await fs.mkdir(input);
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(input, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(auditPackage({ input }), /links are not followed/);
  await fs.rm(path.join(input, 'linked'));
  await assert.rejects(main(['--input', input, '--output', path.join(input, 'report.json')]), /outside/);
  await assert.rejects(main(['--input', input, '--output', path.join(root, 'missing', 'report.json')]), /parent directory does not exist; create it outside/);
  await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
  const output = path.join(root, 'report.json');
  await main(['--input', input, '--output', output]);
  const prior = await fs.readFile(output, 'utf8');
  await assert.rejects(main(['--input', input, '--output', output]), /EEXIST/);
  assert.equal(await fs.readFile(output, 'utf8'), prior);
});

test('comparison rejects mismatched measurement kinds and validates CLI arguments', async t => {
  const root = await fixture(t);
  const directory = await auditPackage({ input: root });
  await assert.rejects(auditPackage({ input: root, baseline: { ...directory, kind: 'zip' } }), /same-kind/);
  await assert.rejects(auditPackage({ input: root, top: 0 }), /top/);
  await assert.rejects(main(['--input', root, '--input', root]), /repeated/);
  await assert.rejects(main(['--input', root, '--mutate', 'yes']), /Invalid/);
});
