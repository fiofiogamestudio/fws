import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const signature = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 };
const number = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
};
const inside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const sortItems = (items, key) => [...items].sort((a, b) => b[key] - a[key] || a.path.localeCompare(b.path));
const sum = (items, key) => number(items.reduce((total, item) => total + item[key], 0), `total ${key}`);
const canonicalPath = name => path.posix.normalize(name.replaceAll('\\', '/')).replace(/\/$/, '');

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function readExactly(handle, length, position) {
  const result = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(result, done, length - done, position + done);
    if (!bytesRead) throw new Error('Truncated ZIP.');
    done += bytesRead;
  }
  return result;
}

function unsafeName(name) {
  const normalized = name.replaceAll('\\', '/');
  return !name || /[\x00-\x1f]/.test(name) || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some(part => part === '..' || part.includes(':'));
}

async function inspectZip(filename, fileBytes) {
  const handle = await fs.open(filename, 'r');
  try {
    const length = Math.min(fileBytes, 65557);
    const tail = await readExactly(handle, length, fileBytes - length);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === signature.end && index + 22 + tail.readUInt16LE(index + 20) === tail.length) {
        end = index;
        break;
      }
    }
    if (end < 0) throw new Error('ZIP end record missing or trailing data present.');
    const entries = tail.readUInt16LE(end + 10);
    const centralBytes = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (entries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 is not supported; use a ZIP64-aware audit tool.');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== entries) throw new Error('Split ZIP is not supported.');
    const endOffset = fileBytes - length + end;
    if (centralOffset + centralBytes !== endOffset) throw new Error('Unexpected ZIP central directory boundaries.');
    const items = [];
    const issues = [];
    const seen = new Set();
    const ranges = [];
    let position = centralOffset;
    for (let index = 0; index < entries; index++) {
      if (position + 46 > endOffset) throw new Error('Truncated ZIP central record.');
      const header = await readExactly(handle, 46, position);
      if (header.readUInt32LE(0) !== signature.central) throw new Error('Invalid ZIP central record.');
      const flags = header.readUInt16LE(8);
      const compressedBytes = header.readUInt32LE(20);
      const bytes = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const localOffset = header.readUInt32LE(42);
      if ([compressedBytes, bytes, localOffset].includes(0xffffffff)) throw new Error('ZIP64 entry is not supported.');
      if (header.readUInt16LE(34)) throw new Error('Split ZIP entry is not supported.');
      if (localOffset + 30 > centralOffset) throw new Error('Invalid ZIP local header offset.');
      if (position + 46 + nameLength + extraLength + commentLength > endOffset) throw new Error('ZIP record exceeds directory bounds.');
      const rawName = await readExactly(handle, nameLength, position + 46);
      const local = await readExactly(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== signature.local) throw new Error('Invalid ZIP local header.');
      if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== header.readUInt16LE(10)) throw new Error('ZIP local and central flags/method disagree.');
      const localNameLength = local.readUInt16LE(26);
      const payloadOffset = localOffset + 30 + localNameLength + local.readUInt16LE(28);
      const payloadEnd = payloadOffset + compressedBytes;
      if (payloadEnd > centralOffset) throw new Error('ZIP payload exceeds available archive data.');
      const localName = await readExactly(handle, localNameLength, localOffset + 30);
      if (!localName.equals(rawName)) throw new Error('ZIP local and central entry names disagree.');
      // Bit 3 permits sizes/CRC to be deferred to a trailing data descriptor.
      if (!(flags & 8) && (local.readUInt32LE(14) !== header.readUInt32LE(16) || local.readUInt32LE(18) !== compressedBytes || local.readUInt32LE(22) !== bytes)) throw new Error('ZIP local and central sizes/CRC disagree.');
      ranges.push({ start: localOffset, end: payloadEnd });
      const utf8 = !!(flags & 0x800);
      const name = rawName.toString(utf8 ? 'utf8' : 'latin1');
      const normalized = name.replaceAll('\\', '/');
      if (unsafeName(name)) issues.push({ path: name, issue: 'unsafe-path' });
      if (!utf8 && rawName.some(byte => byte > 127)) issues.push({ path: name, issue: 'legacy-name-rendered-as-latin1' });
      if (utf8 && !Buffer.from(name, 'utf8').equals(rawName)) issues.push({ path: name, issue: 'invalid-utf8-name' });
      const canonical = canonicalPath(name);
      if (seen.has(canonical)) issues.push({ path: name, issue: 'duplicate-path' });
      seen.add(canonical);
      if (flags & 1) issues.push({ path: name, issue: 'encrypted-entry' });
      const unixMode = header.readUInt32LE(38) >>> 16;
      if ((unixMode & 0xf000) === 0xa000) issues.push({ path: name, issue: 'symbolic-link' });
      if (!normalized.endsWith('/')) items.push({
        path: name, bytes, compressedBytes, method: header.readUInt16LE(10),
        crc32: header.readUInt32LE(16).toString(16).padStart(8, '0'),
      });
      position += 46 + nameLength + extraLength + commentLength;
    }
    if (position !== endOffset) throw new Error('Unexpected data in ZIP central directory.');
    ranges.sort((a, b) => a.start - b.start);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index].start < ranges[index - 1].end) throw new Error('ZIP local entries overlap.');
    }
    return { items, issues, archiveEntries: entries };
  } finally { await handle.close(); }
}

async function inspectDirectory(root) {
  const items = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw new Error(`Directory links are not followed: ${filename}`);
      if (stat.isDirectory()) await visit(filename);
      else if (stat.isFile()) {
        const sha256 = await hashFile(filename);
        const after = await fs.stat(filename);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error(`File changed during audit: ${filename}`);
        items.push({ path: path.relative(root, filename).split(path.sep).join('/'), bytes: number(stat.size, 'file bytes'), sha256 });
      } else throw new Error(`Non-regular package input: ${filename}`);
    }
  }
  await visit(root);
  return { items, issues: [] };
}

function comparison(current, baseline) {
  if (!baseline || baseline.schemaVersion !== VERSION || baseline.kind !== current.kind || !Array.isArray(baseline.items)) throw new Error('Baseline must be a same-kind audit report with the same schema version.');
  for (const item of baseline.items) {
    if (!item || typeof item.path !== 'string' || !item.path) throw new Error('Invalid baseline item path.');
    number(item.bytes, 'baseline item bytes');
    if (baseline.kind === 'directory' && !/^[a-f0-9]{64}$/i.test(item.sha256 ?? '')) throw new Error('Invalid baseline item SHA-256.');
    if (baseline.kind === 'zip') {
      number(item.compressedBytes, 'baseline item compressed bytes');
      if (!/^[a-f0-9]{8}$/i.test(item.crc32 ?? '')) throw new Error('Invalid baseline item CRC32.');
    }
  }
  if (baseline.expandedBytes !== sum(baseline.items, 'bytes')) throw new Error('Baseline expandedBytes disagrees with its item total.');
  if (baseline.fileCount !== baseline.items.length) throw new Error('Baseline fileCount disagrees with its items.');
  if (baseline.maxFileBytes !== baseline.items.reduce((maximum, item) => Math.max(maximum, item.bytes), 0)) throw new Error('Baseline maxFileBytes disagrees with its items.');
  if (baseline.kind === 'zip') {
    number(baseline.archiveBytes, 'baseline archive bytes');
    if (baseline.compressedPayloadBytes !== sum(baseline.items, 'compressedBytes')) throw new Error('Baseline compressedPayloadBytes disagrees with its item total.');
    if (baseline.archiveBytes < baseline.compressedPayloadBytes || baseline.archiveOverheadBytes !== baseline.archiveBytes - baseline.compressedPayloadBytes) throw new Error('Baseline archive size/overhead is inconsistent.');
  }
  const keys = current.kind === 'zip' ? ['expandedBytes', 'archiveBytes', 'compressedPayloadBytes'] : ['expandedBytes'];
  const totals = Object.fromEntries(keys.map(key => {
    number(baseline[key], `baseline ${key}`);
    const savedBytes = baseline[key] - current[key];
    return [key, { before: baseline[key], after: current[key], savedBytes, savedPercent: baseline[key] ? savedBytes * 100 / baseline[key] : null }];
  }));
  if (baseline.items.length !== new Set(baseline.items.map(item => canonicalPath(item.path))).size || current.items.length !== new Set(current.items.map(item => canonicalPath(item.path))).size) throw new Error('Cannot compare reports containing duplicate item paths.');
  const before = new Map(baseline.items.map(item => [item.path, item]));
  const after = new Map(current.items.map(item => [item.path, item]));
  const changes = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(name);
    const b = after.get(name);
    if (a) number(a.bytes, 'baseline item bytes');
    if (!a || !b || a.bytes !== b.bytes || a.sha256 !== b.sha256 || a.crc32 !== b.crc32 || a.compressedBytes !== b.compressedBytes) {
      changes.push({ path: name, status: !a ? 'added' : !b ? 'removed' : 'changed', beforeBytes: a?.bytes ?? 0, afterBytes: b?.bytes ?? 0, savedBytes: (a?.bytes ?? 0) - (b?.bytes ?? 0) });
    }
  }
  return { baselineInput: baseline.input, totals, changes };
}

export async function auditPackage({ input, top = 20, baseline }) {
  if (!Number.isSafeInteger(top) || top < 1 || top > 10000) throw new Error('top must be an integer from 1 to 10000.');
  const filename = path.resolve(input);
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error('Input must not be a link.');
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() && path.extname(filename).toLowerCase() === '.zip' ? 'zip' : null;
  if (!kind) throw new Error('Input must be a directory or a regular .zip file.');
  const data = kind === 'directory' ? await inspectDirectory(filename) : await inspectZip(filename, stat.size);
  const items = data.items.sort((a, b) => a.path.localeCompare(b.path));
  const report = { schemaVersion: VERSION, generatedAt: new Date().toISOString(), input: filename, kind,
    measurement: kind === 'zip' ? 'central-directory-declared-sizes; content-integrity-not-verified' : 'logical-file-bytes; links-not-followed',
    fileCount: items.length, expandedBytes: sum(items, 'bytes'), maxFileBytes: items.reduce((maximum, item) => Math.max(maximum, item.bytes), 0), issues: data.issues };
  if (kind === 'zip') {
    Object.assign(report, { archiveBytes: stat.size, archiveSha256: await hashFile(filename), archiveEntries: data.archiveEntries, compressedPayloadBytes: sum(items, 'compressedBytes') });
    const after = await fs.stat(filename);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Archive changed during audit.');
    report.archiveOverheadBytes = report.archiveBytes - report.compressedPayloadBytes;
    report.topCompressed = sortItems(items, 'compressedBytes').slice(0, top);
  }
  const groups = new Map();
  for (const item of items) {
    const extension = path.posix.extname(item.path.replaceAll('\\', '/')).toLowerCase() || '(none)';
    if (!groups.has(extension)) groups.set(extension, { extension, files: 0, bytes: 0, ...(kind === 'zip' ? { compressedBytes: 0 } : {}) });
    const group = groups.get(extension);
    group.files++;
    group.bytes += item.bytes;
    if (kind === 'zip') group.compressedBytes += item.compressedBytes;
  }
  Object.assign(report, { extensions: [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.extension.localeCompare(b.extension)), topExpanded: sortItems(items, 'bytes').slice(0, top), items });
  if (baseline) report.comparison = comparison(report, typeof baseline === 'string' ? JSON.parse(await fs.readFile(baseline, 'utf8')) : baseline);
  return report;
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node audit-package.mjs --input <directory|file.zip> [--top 20] [--baseline <report.json>] [--output <new-report.json>]');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--input', '--top', '--baseline', '--output'].includes(key) || !args[index + 1] || Object.hasOwn(options, key.slice(2))) throw new Error(`Invalid or repeated argument: ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  if (!options.input) throw new Error('--input is required.');
  if (options.top !== undefined) options.top = Number(options.top);
  if (options.output) {
    const inputReal = await fs.realpath(options.input);
    const parent = path.dirname(path.resolve(options.output));
    let parentReal;
    try { parentReal = await fs.realpath(parent); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Report parent directory does not exist; create it outside the package first: ${parent}`);
      throw error;
    }
    const outputReal = path.join(parentReal, path.basename(options.output));
    if (inside(outputReal, inputReal)) throw new Error('Report output must be outside the audited input.');
  }
  const report = await auditPackage(options);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await fs.writeFile(path.resolve(options.output), content, { encoding: 'utf8', flag: 'wx' });
  else console.log(content.trimEnd());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
