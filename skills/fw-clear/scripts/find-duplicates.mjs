import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const warning = 'Content equality does not prove that a path is dispensable. Audit consumers, Git ownership, unique evidence and retained dependencies before selecting cleanup targets. No keeper is recommended and no deletion is authorized or performed. Duplicate logical bytes are theoretical content redundancy, not physical reclaimable space.';
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (left, right) => key(path.resolve(left)) === key(path.resolve(right));
const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const fingerprint = info => [info.size, info.mtimeNs ?? info.mtimeMs, info.ctimeNs ?? info.ctimeMs, info.dev, info.ino, info.mode, info.nlink].join('|');
const identity = info => info.dev !== undefined && info.ino !== undefined && String(info.ino) !== '0' ? `${info.dev}:${info.ino}` : null;
const failure = message => Object.assign(new Error(message), { code: 'UNSTABLE_OR_REDIRECTED' });
const safeNumber = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Logical byte/count value exceeds the safe integer range.');
  return number;
};
const add = (left, right) => safeNumber(left + right);
const stat = (io, filename) => io.lstat(filename, { bigint: true });

function optionsFor({ minBytes = 1, maxBytes = Number.MAX_SAFE_INTEGER, suffixes = [], concurrency = 2, filePaths, io = fs, onProgress } = {}) {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < minBytes) throw new Error('Byte thresholds must be nonnegative safe integers, with minBytes <= maxBytes.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be an integer from 1 to 8.');
  if (!Array.isArray(suffixes) || suffixes.some(value => typeof value !== 'string' || !/^\.[^\s.,/\\*?:<>|\x00-\x1f]+(?:\.[^\s.,/\\*?:<>|\x00-\x1f]+)*$/.test(value))) throw new Error('Suffixes must be explicit extensions such as .png or .tar.gz, without wildcards.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('onProgress must be a function.');
  if (filePaths !== undefined && (!Array.isArray(filePaths) || filePaths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)))) throw new Error('filePaths must be an array of explicit absolute file paths.');
  return { minBytes, maxBytes, suffixes: [...new Set(suffixes.map(value => value.toLowerCase()))], concurrency, filePaths, io, onProgress };
}

async function validateRoots(values, io) {
  if (!Array.isArray(values) || values.length < 2) throw new Error('Select at least two explicit absolute directory roots.');
  const roots = values.map(value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('Roots must be explicit absolute directory paths.');
    const root = path.resolve(value);
    if (same(root, path.parse(root).root)) throw new Error('Drive/filesystem roots are not accepted.');
    return root;
  });
  for (let i = 0; i < roots.length; i++) for (let j = 0; j < i; j++) {
    if (within(roots[i], roots[j]) || within(roots[j], roots[i])) throw new Error('Roots must be separate and non-overlapping.');
  }
  const seen = new Set();
  for (const root of roots) {
    const info = await stat(io, root);
    if (!info.isDirectory() || info.isSymbolicLink() || !same(root, await io.realpath(root))) throw new Error('Roots must be real, non-redirected directories.');
    const physical = identity(info);
    if (!physical) throw new Error('Cannot establish a physical identity for a root.');
    if (seen.has(physical)) throw new Error('Roots resolve to the same physical directory.');
    seen.add(physical);
  }
  return roots;
}

async function verifyFile(file, io) {
  const info = await stat(io, file.path);
  if (!info.isFile() || info.isSymbolicLink() || fingerprint(info) !== file.fingerprint || !same(file.path, await io.realpath(file.path))) throw failure('File changed or became linked/redirected since enumeration.');
}

async function hashFile(file, io, onRead) {
  await verifyFile(file, io);
  const handle = await io.open(file.path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || fingerprint(before) !== file.fingerprint) throw failure('Opened file differs from the enumerated file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    // Bound reads to the enumerated length, then check EOF. An active writer
    // cannot turn this read-only audit into an unbounded stream.
    while (total < file.logicalBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.logicalBytes - total), null);
      if (!bytesRead) throw failure('File became shorter while hashing.');
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      onRead(bytesRead);
    }
    const { bytesRead } = await handle.read(buffer, 0, 1, null);
    onRead(bytesRead);
    if (bytesRead || fingerprint(await handle.stat({ bigint: true })) !== file.fingerprint) throw failure('File changed while hashing.');
    await verifyFile(file, io);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

// io is injectable for deterministic filesystem failures and drift tests.
// This tool reads metadata/content only; its output is never an execution plan.
export async function findDuplicates(rootValues, options = {}) {
  const { minBytes, maxBytes, suffixes, concurrency, filePaths, io, onProgress } = optionsFor(options);
  const roots = await validateRoots(rootValues, io);
  const listedFiles = filePaths === undefined ? null : [...new Map(filePaths.map(filename => {
    const resolved = path.resolve(filename);
    if (!roots.some(root => within(resolved, root) && !same(resolved, root))) throw new Error(`File scope entry is not below a selected root: ${filename}`);
    return [key(resolved), resolved];
  })).values()];
  const started = Date.now();
  const progress = { enumeratedFiles: 0, enumeratedDirectories: 0, hashedPhysicalFiles: 0, hashReadBytes: 0 };
  let lastProgress = started - 5000;
  const notify = (phase, force = false) => {
    const now = Date.now();
    if (onProgress && (force || now - lastProgress >= 5000)) {
      onProgress({ ...progress, phase, elapsedMs: now - started });
      lastProgress = now;
    }
  };
  const files = [], directories = [], errors = [], skips = [];
  const seenDirectories = new Map();
  const inspectedDirectories = new Set();
  const blockedPaths = roots.map(() => new Set());
  const issue = (list, filename, rootIndex, kind, reason, error, knownLogicalBytes = null) => {
    list.push({ path: filename, rootIndex, relativePath: path.relative(roots[rootIndex], filename) || '.', kind, reason, code: error?.code ?? null, knownLogicalBytes });
    blockedPaths[rootIndex].add(key(filename));
  };
  const blocked = file => {
    for (let filename = file.path; within(filename, roots[file.rootIndex]); filename = path.dirname(filename)) {
      if (blockedPaths[file.rootIndex].has(key(filename))) return true;
      if (same(filename, roots[file.rootIndex])) break;
    }
    return false;
  };
  const recordFile = (filename, rootIndex, info) => {
    const logicalBytes = safeNumber(info.size);
    const physicalIdentity = identity(info);
    const eligible = logicalBytes >= minBytes && logicalBytes <= maxBytes && (!suffixes.length || suffixes.some(suffix => filename.toLowerCase().endsWith(suffix)));
    files.push({ path: filename, rootIndex, relativePath: path.relative(roots[rootIndex], filename), logicalBytes, physicalIdentity, linkCount: safeNumber(info.nlink), fingerprint: fingerprint(info), eligible });
    if (!physicalIdentity) issue(skips, filename, rootIndex, 'file', 'file-identity-unavailable', null, logicalBytes);
    progress.enumeratedFiles++;
    notify('enumerating');
  };
  async function inspectDirectory(directory, rootIndex) {
    if (inspectedDirectories.has(key(directory))) return null;
    inspectedDirectories.add(key(directory));
    const info = await stat(io, directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !same(directory, await io.realpath(directory))) throw failure('Directory became linked or redirected.');
    const physical = identity(info);
    if (!physical) { issue(skips, directory, rootIndex, 'directory', 'directory-identity-unavailable'); return null; }
    if (seenDirectories.has(physical)) { issue(skips, directory, rootIndex, 'directory', `physical-directory-alias-of:${seenDirectories.get(physical)}`); return null; }
    seenDirectories.set(physical, directory);
    directories.push({ path: directory, rootIndex, physicalIdentity: physical, fingerprint: fingerprint(info) });
    progress.enumeratedDirectories++;
    notify('enumerating');
    return info;
  }
  async function visit(directory, rootIndex) {
    try {
      const before = await inspectDirectory(directory, rootIndex);
      if (!before) return;
      for (const entry of await io.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        try {
          const info = await stat(io, filename);
          if (info.isSymbolicLink()) { issue(skips, filename, rootIndex, 'link', 'link-not-followed'); continue; }
          if (!same(filename, await io.realpath(filename))) { issue(skips, filename, rootIndex, 'redirect', 'redirected-entry-not-followed'); continue; }
          if (info.isDirectory()) await visit(filename, rootIndex);
          else if (info.isFile()) recordFile(filename, rootIndex, info);
          else issue(skips, filename, rootIndex, 'special', 'special-file-not-read');
        } catch (error) { issue(errors, filename, rootIndex, 'entry', error.message, error); }
      }
      if (fingerprint(before) !== fingerprint(await stat(io, directory)) || !same(directory, await io.realpath(directory))) throw failure('Directory changed during enumeration.');
    } catch (error) { issue(errors, directory, rootIndex, 'directory', error.message, error); }
  }
  notify('enumerating', true);
  if (listedFiles === null) for (const [rootIndex, root] of roots.entries()) await visit(root, rootIndex);
  else for (const filename of listedFiles) {
    const rootIndex = roots.findIndex(root => within(filename, root));
    const ancestors = [];
    for (let directory = path.dirname(filename); within(directory, roots[rootIndex]); directory = path.dirname(directory)) {
      ancestors.push(directory);
      if (same(directory, roots[rootIndex])) break;
    }
    for (const directory of ancestors.reverse()) {
      if (blocked({ path: directory, rootIndex })) break;
      try { await inspectDirectory(directory, rootIndex); }
      catch (error) { issue(errors, directory, rootIndex, 'directory', error.message, error); }
    }
    if (blocked({ path: filename, rootIndex })) continue;
    try {
      const info = await stat(io, filename);
      if (info.isSymbolicLink()) issue(skips, filename, rootIndex, 'link', 'link-not-followed');
      else if (!same(filename, await io.realpath(filename))) issue(skips, filename, rootIndex, 'redirect', 'redirected-entry-not-followed');
      else if (!info.isFile()) issue(skips, filename, rootIndex, 'special', 'file-scope-entry-is-not-a-regular-file');
      else recordFile(filename, rootIndex, info);
    } catch (error) { issue(errors, filename, rootIndex, 'entry', error.message, error); }
  }
  const physicalFiles = new Map();
  for (const file of files) {
    if (!file.physicalIdentity) continue;
    if (!physicalFiles.has(file.physicalIdentity)) physicalFiles.set(file.physicalIdentity, { identity: file.physicalIdentity, files: [], logicalBytes: file.logicalBytes, sha256: null, hashAttempted: false });
    physicalFiles.get(file.physicalIdentity).files.push(file);
  }
  const buckets = new Map();
  for (const physical of physicalFiles.values()) {
    const selected = physical.files.filter(file => file.eligible);
    if (!selected.length) continue;
    physical.selected = selected;
    if (physical.files.some(file => file.fingerprint !== physical.files[0].fingerprint || blocked(file))) {
      for (const file of selected) if (!blocked(file)) issue(errors, file.path, file.rootIndex, 'file', 'A physical file alias changed or could not be inspected.', failure('Unstable alias.'), file.logicalBytes);
      continue;
    }
    if (!buckets.has(physical.logicalBytes)) buckets.set(physical.logicalBytes, []);
    buckets.get(physical.logicalBytes).push(physical);
  }
  const candidates = [...buckets.values()].filter(bucket => bucket.length > 1).flat();
  let next = 0;
  notify('hashing', true);
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) {
      const physical = candidates[next++];
      const file = physical.selected[0];
      physical.hashAttempted = true;
      try {
        for (const alias of physical.files) await verifyFile(alias, io);
        physical.sha256 = await hashFile(file, io, bytes => { progress.hashReadBytes = add(progress.hashReadBytes, bytes); notify('hashing'); });
        progress.hashedPhysicalFiles++;
      } catch (error) {
        for (const alias of physical.selected) issue(errors, alias.path, alias.rootIndex, 'file', error.message, error, alias.logicalBytes);
      }
    }
  }));
  notify('rechecking', true);
  // Recheck every observed file, including size-only exclusions. This prevents
  // a stale size bucket from being reported as a complete duplicate discovery.
  for (const file of files) {
    if (blocked(file)) continue;
    try { await verifyFile(file, io); }
    catch (error) { issue(errors, file.path, file.rootIndex, 'file', error.message, error, file.logicalBytes); }
  }
  for (const directory of directories) {
    try {
      const info = await stat(io, directory.path);
      // A listed-file audit does not claim coverage of siblings. Creating an
      // unrelated sibling changes directory mtime/ctime without invalidating
      // the listed files. Keep identity and redirect checks in both modes;
      // recursive discovery additionally needs directory content stability.
      if (!info.isDirectory() || info.isSymbolicLink() || identity(info) !== directory.physicalIdentity || !same(directory.path, await io.realpath(directory.path))) throw failure('Directory identity or redirect boundary changed during discovery.');
      if (listedFiles === null && fingerprint(info) !== directory.fingerprint) throw failure('Directory changed during discovery; its subtree is uncertain.');
    } catch (error) { issue(errors, directory.path, directory.rootIndex, 'directory', error.message, error); }
  }
  const content = new Map();
  for (const physical of candidates) {
    if (!physical.sha256 || physical.files.some(blocked)) continue;
    const contentKey = `${physical.logicalBytes}:${physical.sha256}`;
    if (!content.has(contentKey)) content.set(contentKey, []);
    content.get(contentKey).push(physical);
  }
  const member = file => ({ path: file.path, rootIndex: file.rootIndex, relativePath: file.relativePath, logicalBytes: file.logicalBytes, physicalIdentity: file.physicalIdentity, reportedLinkCount: file.linkCount, metadataFingerprint: file.fingerprint });
  const groups = [...content.values()].filter(values => values.length > 1).map(values => ({
    sha256: values[0].sha256,
    fileLogicalBytes: values[0].logicalBytes,
    independentPhysicalFiles: values.length,
    theoreticalDuplicateLogicalBytes: safeNumber((values.length - 1) * values[0].logicalBytes),
    members: values.flatMap(physical => physical.selected.map(member)).sort((a, b) => a.path.localeCompare(b.path)),
    hasUnobservedHardLinks: values.some(physical => physical.files.some(file => file.linkCount > physical.files.length)),
  })).sort((a, b) => b.theoreticalDuplicateLogicalBytes - a.theoreticalDuplicateLogicalBytes || a.sha256.localeCompare(b.sha256));
  const grouped = new Set(groups.flatMap(group => group.members.map(file => file.physicalIdentity)));
  const hardLinkSets = [...physicalFiles.values()].filter(physical => physical.files.length > 1 || physical.files.some(file => file.linkCount > 1)).map(physical => ({
    physicalIdentity: physical.identity,
    observedPaths: physical.files.map(file => ({ ...member(file), selectedByFilters: file.eligible })),
    observedPathCount: physical.files.length,
    reportedLinkCount: physical.files.reduce((maximum, file) => Math.max(maximum, file.linkCount), 0),
    hasUnobservedLinks: physical.files.some(file => file.linkCount > physical.files.length),
    aliasLogicalBytesExcludedFromDuplicateAmount: safeNumber((physical.files.length - 1) * physical.logicalBytes),
    stable: !physical.files.some(blocked),
  }));
  const totals = list => ({ files: list.length, logicalBytes: list.reduce((sum, file) => add(sum, file.logicalBytes), 0) });
  const selected = files.filter(file => file.eligible);
  const unstablePhysical = new Set([...physicalFiles.values()].filter(physical => physical.files.some(blocked)).map(physical => physical.identity));
  const unknown = selected.filter(file => blocked(file) || !file.physicalIdentity || unstablePhysical.has(file.physicalIdentity));
  const report = {
    schemaVersion: 1,
    kind: 'read-only-content-duplicate-discovery',
    roots,
    scope: {
      mode: listedFiles === null ? 'recursive-roots' : 'explicit-file-list',
      recursiveRootCoverage: listedFiles === null,
      requestedFileEntries: filePaths?.length ?? null,
      distinctRequestedFilePaths: listedFiles?.length ?? null,
      requestedFilePaths: listedFiles,
      duplicateFileEntriesIgnored: filePaths === undefined ? 0 : filePaths.length - listedFiles.length,
      note: listedFiles === null ? 'All reachable regular files under the selected roots are considered, subject to filters and reported issues.' : 'Only explicitly listed files are considered. Unlisted root contents were not traversed, measured or checked for duplicates; completeness applies only to the requested list and filters.',
    },
    filters: { minBytes, maxBytes, suffixes },
    concurrency,
    discoveryComplete: errors.length === 0 && skips.length === 0,
    consistentSnapshot: false,
    deletionAuthorized: false,
    keeperRecommended: false,
    physicalReclaimableBytes: null,
    warning,
    enumerated: totals(files),
    selected: totals(selected),
    excludedByFilters: totals(files.filter(file => !file.eligible)),
    unknown: { ...totals(unknown), members: unknown.map(member), unmeasuredLogicalBytes: errors.length || skips.length ? null : 0 },
    sizeBucketCandidates: candidates.length,
    hashedPhysicalFiles: progress.hashedPhysicalFiles,
    hashReadBytes: progress.hashReadBytes,
    stablePhysicalFilesWithoutObservedSizePeer: [...physicalFiles.values()].filter(physical => physical.selected?.length && !physical.hashAttempted && !physical.files.some(blocked)).length,
    stableHashedPhysicalFilesOutsideDuplicateGroups: candidates.filter(physical => physical.sha256 && !physical.files.some(blocked) && !grouped.has(physical.identity)).length,
    theoreticalDuplicateLogicalBytes: groups.reduce((sum, group) => add(sum, group.theoreticalDuplicateLogicalBytes), 0),
    groups,
    hardLinkSets,
    errors,
    skips,
    elapsedMs: Date.now() - started,
  };
  notify('finished', true);
  return report;
}

export function parseArguments(argv) {
  const result = { roots: [], suffixes: [], json: false, progress: false, help: false, top: 30 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--root', '--files-json', '--min-bytes', '--max-bytes', '--suffix', '--concurrency', '--top', '--json', '--progress', '--help'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (flag !== '--root' && seen.has(flag)) throw new Error(`Repeated argument: ${flag}`);
    seen.add(flag);
    if (['--json', '--progress', '--help'].includes(flag)) { result[flag.slice(2)] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--root') result.roots.push(value);
    else if (flag === '--files-json') {
      if (!path.isAbsolute(value)) throw new Error('--files-json must be an absolute manifest path.');
      result.filesJson = value;
    }
    else if (flag === '--suffix') result.suffixes = value.split(',');
    else {
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid integer for ${flag}`);
      result[{ '--min-bytes': 'minBytes', '--max-bytes': 'maxBytes', '--concurrency': 'concurrency', '--top': 'top' }[flag]] = Number(value);
    }
  }
  optionsFor(result);
  if (result.top > 1000) throw new Error('--top must be between 0 and 1000.');
  if (!result.help && result.roots.length < 2) throw new Error('Provide --root at least twice.');
  return result;
}

export function formatReport(report, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 0 || top > 1000) throw new Error('top must be an integer from 0 to 1000.');
  const shown = report.groups.slice(0, top);
  const lines = [
    'Read-only duplicate content discovery (full SHA256; member order is not a keeper recommendation)',
    `Scope: ${report.scope.mode}. ${report.scope.note}`,
    `Observed: ${report.enumerated.files} paths / ${report.enumerated.logicalBytes} logical bytes; selected: ${report.selected.files} paths.`,
    `Confirmed groups: ${report.groups.length}; theoretical duplicate logical bytes: ${report.theoreticalDuplicateLogicalBytes}. Physical reclaimable bytes: unknown.`,
    `Hashed: ${report.hashedPhysicalFiles} independent files / ${report.hashReadBytes} read bytes.`,
    `Coverage: ${report.discoveryComplete ? 'complete for requested filters at observed times' : 'INCOMPLETE'}; errors: ${report.errors.length}; skips: ${report.skips.length}; no atomic snapshot.`,
    ...shown.flatMap((group, index) => [`${index + 1}. ${group.theoreticalDuplicateLogicalBytes} duplicate logical bytes; ${group.sha256}`, ...group.members.map(file => `  ${file.path} [identity ${file.physicalIdentity}]`)]),
    `Presentation residual: ${report.groups.length - shown.length} groups, ${report.groups.slice(top).reduce((sum, group) => sum + group.theoreticalDuplicateLogicalBytes, 0)} duplicate logical bytes (use --json for all members, errors and skips).`,
    report.warning,
  ];
  return lines.join('\n');
}

export async function readFileList(filename, io = fs) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('File-list manifest must be an absolute path.');
  const before = await stat(io, filename);
  if (!before.isFile() || before.isSymbolicLink() || !same(filename, await io.realpath(filename))) throw new Error('File-list manifest must be a real, non-redirected regular file.');
  if (before.size > 64n * 1024n * 1024n) throw new Error('File-list manifest exceeds 64 MiB.');
  const handle = await io.open(filename, 'r');
  let contents;
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw failure('File-list manifest changed before reading.');
    const buffer = Buffer.alloc(safeNumber(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(1024 * 1024, buffer.length - offset), null);
      if (!bytesRead) throw failure('File-list manifest became shorter while reading.');
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw failure('File-list manifest grew while reading.');
    contents = buffer.toString('utf8');
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw failure('File-list manifest changed while reading.');
  } finally { await handle.close(); }
  if (fingerprint(await stat(io, filename)) !== fingerprint(before) || !same(filename, await io.realpath(filename))) throw failure('File-list manifest changed after reading.');
  const filePaths = JSON.parse(contents.replace(/^\uFEFF/, ''));
  optionsFor({ filePaths });
  return filePaths;
}

const help = 'Usage: node find-duplicates.mjs --root <absolute-dir> --root <absolute-dir> [--root <absolute-dir> ...] [--files-json <absolute-manifest.json>] [--min-bytes N] [--max-bytes N] [--suffix .png,.mp4] [--concurrency 1..8] [--top 0..1000] [--json] [--progress]\nDefaults: min-bytes 1, concurrency 2; empty files excluded unless --min-bytes 0. --files-json accepts a JSON string array and audits ONLY listed paths, without traversing roots. Read-only; no keeper selection or deletion authorization.';
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const filePaths = options.filesJson ? await readFileList(options.filesJson) : undefined;
      const report = await findDuplicates(options.roots, { ...options, filePaths, onProgress: options.progress ? event => process.stderr.write(`${JSON.stringify(event)}\n`) : undefined });
      process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatReport(report, options)}\n`);
      if (!report.discoveryComplete) process.exitCode = 2;
    }
  } catch (error) { process.stderr.write(`find-duplicates: ${error.message}\n`); process.exitCode = 1; }
}
