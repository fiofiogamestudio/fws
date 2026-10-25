import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const warning = 'Content equality does not prove that a path is dispensable. Audit consumers, references, Git ownership, unique evidence and the retained copy before selecting any cleanup target. This tool never creates a deletion plan.';
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (left, right) => key(path.resolve(left)) === key(path.resolve(right));
const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const fingerprint = info => [info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino, info.mode].join('|');
const failure = message => Object.assign(new Error(message), { code: 'UNSTABLE_OR_REDIRECTED' });

async function validateRoot(value, io) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Both roots must be absolute directory paths.');
  const root = path.resolve(value);
  if (same(root, path.parse(root).root)) throw new Error('Drive/filesystem roots are not accepted; select explicit source-copy directories.');
  const info = await io.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(root, await io.realpath(root))) throw new Error('Roots must be real, non-redirected directories.');
  return root;
}

async function enumerate(root, side, io, progress) {
  const tree = { root, side, files: new Map(), directories: new Map(), issues: [] };
  const issue = (filename, kind, reason, error) => tree.issues.push({ side, path: filename, relativePath: path.relative(root, filename) || '.', kind, reason, code: error?.code ?? null, logicalBytes: null });
  async function visit(directory) {
    let before;
    try {
      before = await io.lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink() || !same(directory, await io.realpath(directory))) throw failure('Directory became linked or redirected.');
      tree.directories.set(key(path.relative(root, directory)), { path: directory, fingerprint: fingerprint(before) });
      const entries = await io.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const filename = path.join(directory, entry.name);
        try {
          const info = await io.lstat(filename);
          if (info.isSymbolicLink()) { issue(filename, 'link', 'link-not-followed'); continue; }
          if (!same(filename, await io.realpath(filename))) { issue(filename, 'unknown', 'redirected-entry-not-followed'); continue; }
          if (info.isDirectory()) await visit(filename);
          else if (info.isFile()) {
            const relativePath = path.relative(root, filename);
            tree.files.set(key(relativePath), { path: filename, relativePath, logicalBytes: info.size, fingerprint: fingerprint(info) });
            progress('enumerating');
          } else issue(filename, 'special', 'special-entry-not-read');
        } catch (error) { issue(filename, 'unknown', error.message, error); }
      }
      const after = await io.lstat(directory);
      if (fingerprint(before) !== fingerprint(after) || !same(directory, await io.realpath(directory))) throw failure('Directory changed during enumeration.');
    } catch (error) { issue(directory, 'directory', error.message, error); }
  }
  await visit(root);
  return tree;
}

function blocked(tree, relativePath) {
  const filename = path.resolve(tree.root, relativePath);
  return tree.issues.some(issue => within(filename, issue.path) || within(issue.path, filename));
}

async function verifyFile(file, io) {
  const info = await io.lstat(file.path);
  if (!info.isFile() || info.isSymbolicLink() || fingerprint(info) !== file.fingerprint || !same(file.path, await io.realpath(file.path))) throw failure('File changed or became linked/redirected since enumeration.');
  return info;
}

async function hashFile(file, io, readBytes) {
  await verifyFile(file, io);
  const handle = await io.open(file.path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || fingerprint(before) !== file.fingerprint) throw failure('Opened file differs from enumerated file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
      readBytes(result.bytesRead);
    }
    const after = await handle.stat();
    if (total !== file.logicalBytes || fingerprint(before) !== fingerprint(after)) throw failure('File changed while hashing.');
    await verifyFile(file, io);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function recheckDirectories(tree, io) {
  for (const directory of tree.directories.values()) {
    try {
      const info = await io.lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink() || directory.fingerprint !== fingerprint(info) || !same(directory.path, await io.realpath(directory.path))) throw failure('Directory changed during comparison; its subtree is uncertain.');
    } catch (error) {
      tree.issues.push({ side: tree.side, path: directory.path, relativePath: path.relative(tree.root, directory.path) || '.', kind: 'directory', reason: error.message, code: error.code ?? null, logicalBytes: null });
    }
  }
}

// Read-only comparison, not a duplicate remover. io is injectable for fault tests.
export async function compareTrees(candidate, retain, { io = fs, onProgress } = {}) {
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('onProgress must be a function.');
  const roots = await Promise.all([validateRoot(candidate, io), validateRoot(retain, io)]);
  if (within(roots[0], roots[1]) || within(roots[1], roots[0])) throw new Error('Candidate and retained roots must be separate and non-overlapping.');
  const started = Date.now();
  const progress = { enumeratedFiles: 0, comparedFiles: 0, hashReadBytes: 0, hashedPairs: 0 };
  let lastProgress = started - 5000;
  const notify = (phase, force = false) => {
    if (phase === 'enumerating') progress.enumeratedFiles++;
    const now = Date.now();
    if (onProgress && (force || now - lastProgress >= 5000)) {
      onProgress({ ...progress, phase, elapsedMs: now - started });
      lastProgress = now;
    }
  };
  const [left, right] = await Promise.all(roots.map((root, index) => enumerate(root, index ? 'retain' : 'candidate', io, notify)));
  const comparisons = [];
  for (const [relativeKey, file] of left.files) {
    const other = right.files.get(relativeKey);
    const result = { kind: 'file', path: file.path, relativePath: file.relativePath, logicalBytes: file.logicalBytes, retainedPath: other?.path ?? path.join(right.root, file.relativePath), retainedLogicalBytes: other?.logicalBytes ?? null, status: 'unknown', reason: '' };
    try {
      if (blocked(left, file.relativePath) || blocked(right, file.relativePath)) throw failure('A skipped, unreadable or changing entry prevents comparison.');
      if (!other) {
        await verifyFile(file, io);
        // Do not confuse a failed enumeration with an absent counterpart.
        if (right.directories.has(relativeKey)) {
          result.status = 'different'; result.reason = 'retained-counterpart-is-directory';
        } else {
          try { await io.lstat(result.retainedPath); throw failure('Retained counterpart appeared or was not enumerated.'); }
          catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
          result.status = 'candidateOnly'; result.reason = 'retained-counterpart-missing';
        }
      } else {
        if (file.logicalBytes !== other.logicalBytes) {
          await Promise.all([verifyFile(file, io), verifyFile(other, io)]);
          result.status = 'different'; result.reason = 'different-lengths-not-hashed';
        }
        else {
          // hashFile checks each path immediately before opening it. Avoid a
          // duplicate precheck here, retaining handle and post-stream checks.
          progress.hashedPairs++;
          const hashes = await Promise.allSettled([file, other].map(item => hashFile(item, io, bytes => { progress.hashReadBytes += bytes; notify('hashing'); })));
          const failed = hashes.find(value => value.status === 'rejected');
          if (failed) throw failed.reason;
          // Recheck both paths after both streams finish. The first stream may
          // have completed before a concurrent writer changed it.
          await Promise.all([verifyFile(file, io), verifyFile(other, io)]);
          result.candidateSha256 = hashes[0].value;
          result.retainedSha256 = hashes[1].value;
          result.status = hashes[0].value === hashes[1].value ? 'identical' : 'different';
          result.reason = result.status === 'identical' ? 'sha256-equal' : 'sha256-different';
        }
      }
    } catch (error) { result.status = 'unknown'; result.reason = error.message; result.code = error.code ?? null; }
    comparisons.push(result);
    progress.comparedFiles++;
    notify('comparing');
  }
  await Promise.all([recheckDirectories(left, io), recheckDirectories(right, io)]);
  // A mutation or incomplete directory can invalidate an otherwise equal file.
  for (const row of comparisons) {
    if (blocked(left, row.relativePath) || blocked(right, row.relativePath)) {
      row.status = 'unknown'; row.reason = 'A skipped, unreadable or changing entry prevents comparison.';
      delete row.candidateSha256; delete row.retainedSha256;
    }
  }
  const retainedOnly = [];
  const retainedUnknown = [];
  for (const [relativeKey, file] of right.files) {
    if (left.files.has(relativeKey)) continue;
    const row = { path: file.path, relativePath: file.relativePath, logicalBytes: file.logicalBytes, candidatePath: path.join(left.root, file.relativePath) };
    if (blocked(left, file.relativePath) || blocked(right, file.relativePath)) retainedUnknown.push({ ...row, status: 'unknown', reason: 'Candidate or retained subtree is uncertain.' });
    else retainedOnly.push({ ...row, status: 'retainedOnly' });
  }
  const summary = Object.fromEntries(['identical', 'different', 'candidateOnly', 'unknown'].map(status => [status, { files: 0, logicalBytes: 0 }]));
  for (const row of comparisons) { summary[row.status].files++; summary[row.status].logicalBytes += row.logicalBytes; }
  const issues = [...left.issues, ...right.issues];
  const total = tree => ({ files: tree.files.size, logicalBytes: [...tree.files.values()].reduce((sum, row) => sum + row.logicalBytes, 0), directories: tree.directories.size });
  notify('finished', true);
  return {
    schemaVersion: 1, candidateRoot: roots[0], retainedRoot: roots[1],
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    measurement: 'logical-file-lengths', hashAlgorithm: 'sha256', consistentSnapshot: false,
    comparisonComplete: issues.length === 0 && summary.unknown.files === 0 && retainedUnknown.length === 0,
    candidateTotals: total(left), retainedTotals: total(right), summary,
    unmeasured: { candidateLogicalBytes: left.issues.length ? null : 0, retainedLogicalBytes: right.issues.length ? null : 0 },
    ...progress, comparisons, retainedOnly, retainedUnknown, issues, warning,
  };
}

const usage = 'Usage: node compare-trees.mjs --candidate <absolute-directory> --retain <absolute-directory> [--top 0..1000] [--json] [--progress]';
export function parseArguments(args) {
  const options = { top: 30, json: false, progress: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!['--candidate', '--retain', '--top', '--json', '--progress', '--help'].includes(option) || seen.has(option)) throw new Error(usage);
    seen.add(option);
    if (['--json', '--progress', '--help'].includes(option)) { options[option.slice(2)] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (option === '--top') {
      if (!/^\d+$/.test(value) || Number(value) > 1000) throw new Error(usage);
      options.top = Number(value);
    } else options[option.slice(2)] = value;
  }
  if (!options.help && (!options.candidate || !options.retain)) throw new Error(usage);
  return options;
}

export function formatReport(report, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 0 || top > 1000) throw new Error('top must be an integer from 0 to 1000.');
  const size = bytes => `${(bytes / 1024 ** 3).toFixed(3)} GiB (${bytes} bytes)`;
  const lines = [
    `Candidate: ${report.candidateRoot}`, `Retain: ${report.retainedRoot}`,
    `Candidate measured: ${report.candidateTotals.files} files, ${size(report.candidateTotals.logicalBytes)}`,
    `Comparison complete: ${report.comparisonComplete}; live filesystem, not an atomic snapshot.`,
    `Hash reads: ${size(report.hashReadBytes)} across ${report.hashedPairs} same-relative/same-size pairs.`,
  ];
  for (const status of ['identical', 'different', 'candidateOnly', 'unknown', 'retainedOnly', 'retainedUnknown']) {
    const rows = (status === 'retainedOnly' ? report.retainedOnly : status === 'retainedUnknown' ? report.retainedUnknown : report.comparisons.filter(row => row.status === status)).slice().sort((a, b) => b.logicalBytes - a.logicalBytes || a.relativePath.localeCompare(b.relativePath));
    lines.push(`${status}: ${rows.length} files, ${size(rows.reduce((sum, row) => sum + row.logicalBytes, 0))}`);
    for (const row of rows.slice(0, top)) lines.push(`  ${size(row.logicalBytes)}\t${row.path}\t${row.retainedPath ?? row.candidatePath}\t${row.reason ?? ''}`);
    const omitted = rows.slice(top);
    if (omitted.length) lines.push(`  Presentation residual: ${omitted.length} files, ${size(omitted.reduce((sum, row) => sum + row.logicalBytes, 0))}; all paths available with --json.`);
  }
  lines.push(`Unknown/skipped entries: ${report.issues.length}; unmeasured candidate bytes: ${report.unmeasured.candidateLogicalBytes ?? 'unknown'}; unmeasured retained bytes: ${report.unmeasured.retainedLogicalBytes ?? 'unknown'}.`);
  for (const row of report.issues.slice(0, top)) lines.push(`  UNKNOWN ${row.side}\t${row.path}\t${row.reason}`);
  if (report.issues.length > top) lines.push(`  ${report.issues.length - top} additional unknown entries are included with --json.`);
  lines.push(warning, 'Logical bytes are not allocated or reclaimable disk space.');
  return lines.join('\n');
}

if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const onProgress = options.progress ? value => console.error(`Compare ${value.phase}: ${value.enumeratedFiles} enumerated, ${value.comparedFiles} compared, ${value.hashReadBytes} bytes read (${value.elapsedMs} ms)`) : undefined;
      const report = await compareTrees(options.candidate, options.retain, { onProgress });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report, options));
      if (!report.comparisonComplete) process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
