import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { errorResult, fail, frontmatter, isWithin, readUtf8, samePath, statOrNull, validateSource } from './lib/catalog.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function identity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }

async function targetLocation(value, sourceRoot, io) {
  if (typeof value !== 'string' || !value.trim()) fail('target-required', 'Pass an explicit --target directory.');
  if (value.split(/[\\/]/).includes('..')) fail('unsafe-target', 'Target cannot contain parent traversal segments.');
  const target = path.resolve(value);
  if (samePath(target, path.parse(target).root)) fail('unsafe-target', 'A filesystem root cannot be an installation target.');
  const parts = target.replaceAll('\\', '/').toLowerCase().split('/');
  if (parts.includes('.system') || /\/.codex\/plugins(?:\/|$)/.test(target.replaceAll('\\', '/').toLowerCase())) {
    fail('protected-target', 'Official system and plugin skill locations are not installation targets.');
  }
  const info = await statOrNull(target, io);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('unsafe-target', 'Target must be a real directory, not a link or file.');
  const parent = path.dirname(target);
  const parentInfo = await io.lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('unsafe-target', 'Target parent must be an existing real directory.');
  const realParent = await io.realpath(parent);
  if (!samePath(realParent, parent)) fail('unsafe-target', 'Target ancestors cannot redirect through symbolic links.');
  const physicalTarget = info ? await io.realpath(target) : path.join(realParent, path.basename(target));
  if (isWithin(physicalTarget, sourceRoot) || isWithin(sourceRoot, physicalTarget)) {
    fail('overlapping-paths', 'Source and target cannot be equal or contain one another.');
  }
  return { target: physicalTarget, parent: realParent, info };
}

async function inspectEntry(filename, expectedName, source, migrate, io) {
  const info = await statOrNull(filename, io);
  if (!info) return null;
  if (info.isSymbolicLink()) {
    let destination;
    try { destination = await io.realpath(filename); } catch { fail('abnormal-link', 'Existing skill link is broken.', { path: filename }); }
    if (source && samePath(destination, source)) return { kind: 'linked', identity: identity(info) };
    fail('abnormal-link', 'Existing skill link does not point to this canonical source.', { path: filename });
  }
  if (!info.isDirectory()) fail('conflict', 'Existing skill path is not a directory.', { path: filename });
  const skillFile = path.join(filename, 'SKILL.md');
  const skillInfo = await statOrNull(skillFile, io);
  if (!skillInfo?.isFile() || skillInfo.isSymbolicLink()) fail('unknown-content', 'Existing directory has no regular SKILL.md identity.', { path: filename });
  let metadata;
  try { metadata = frontmatter(await readUtf8(skillFile, io), skillFile); }
  catch { fail('unknown-content', 'Existing directory has no recognized skill identity.', { path: filename }); }
  if (metadata.name !== expectedName) fail('identity-mismatch', 'Existing skill identity does not match its catalog name.', { path: filename });
  if (!migrate) fail('migration-required', 'Existing known skill requires explicit --migrate-legacy; it will be backed up.', { path: filename });
  return { kind: 'backup', identity: identity(info) };
}

async function makePlan(options, io) {
  const { root, catalog } = await validateSource(path.resolve(options.sourceRoot ?? repositoryRoot), io);
  const requested = options.skills ?? catalog.skills.map(skill => skill.name);
  if (!Array.isArray(requested) || !requested.length || requested.some(name => !catalog.skills.some(skill => skill.name === name))) {
    fail('unknown-skill', 'Select canonical skill names from catalog.json with --skill.');
  }
  const selected = new Set(requested);
  const location = await targetLocation(options.target, root, io);
  const backups = [];
  const links = [];
  const skills = [];
  for (const skill of catalog.skills) {
    if (!selected.has(skill.name)) continue;
    const source = path.join(root, 'skills', skill.name);
    const destination = path.join(location.target, skill.name);
    const current = await inspectEntry(destination, skill.name, source, options.migrateLegacy === true, io);
    if (current?.kind === 'backup') backups.push({ path: destination, name: skill.name, identity: current.identity });
    if (current?.kind !== 'linked') links.push({ source, destination, name: skill.name });
    for (const legacyName of skill.legacyNames) {
      const legacyPath = path.join(location.target, legacyName);
      const legacy = await inspectEntry(legacyPath, legacyName, null, options.migrateLegacy === true, io);
      if (legacy) backups.push({ path: legacyPath, name: legacyName, identity: legacy.identity });
    }
    skills.push({ name: skill.name, source, destination, status: current?.kind === 'linked' ? 'already-linked' : current ? 'migrate' : 'install' });
  }
  const backupRoot = backups.length ? path.join(location.parent, `${path.basename(location.target)}.fws-backup-${Date.now()}-${randomUUID()}`) : null;
  return { root, location, backups, links, backupRoot, skills };
}

async function checkTarget(plan, expectedIdentity, io) {
  const info = await io.lstat(plan.location.target);
  if (!info.isDirectory() || info.isSymbolicLink() || identity(info) !== expectedIdentity || !samePath(await io.realpath(plan.location.target), plan.location.target)) {
    fail('target-changed', 'Target directory identity changed during installation.');
  }
}

export async function installSkills(options = {}, io = fs) {
  const plan = await makePlan(options, io); // All known conflicts are rejected before the first write.
  const result = {
    ok: true, mode: options.apply === true ? 'apply' : 'preview', sourceRoot: plan.root,
    target: plan.location.target, backupRoot: plan.backupRoot, skills: plan.skills,
    changes: { links: plan.links.length, backups: plan.backups.length },
    actions: [
      ...plan.backups.map(item => ({ type: 'backup', from: item.path, to: path.join(plan.backupRoot, item.name) })),
      ...plan.links.map(item => ({ type: 'link', from: item.source, to: item.destination })),
    ],
  };
  if (!options.apply || (!plan.backups.length && !plan.links.length)) return result;

  const journal = [];
  let createdTarget = false;
  let createdBackup = false;
  let targetIdentity = plan.location.info ? identity(plan.location.info) : null;
  let lock;
  const lockPath = path.join(plan.location.parent, `.${path.basename(plan.location.target)}.fws-install.lock`);
  const lockToken = randomUUID();
  let lockIdentity;
  try {
    try { lock = await io.open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') fail('install-locked', 'Another installation or an interrupted installation owns the lock.', { path: lockPath }); throw error; }
    lockIdentity = identity(await lock.stat());
    await lock.writeFile(lockToken, 'utf8');
    await lock.sync();
    if (!plan.location.info) {
      await io.mkdir(plan.location.target);
      createdTarget = true;
      targetIdentity = identity(await io.lstat(plan.location.target));
    }
    await checkTarget(plan, targetIdentity, io);
    // Repeat preflight after taking the cooperative installer lock.
    const lockedPlan = await makePlan(options, io);
    if (JSON.stringify(lockedPlan.backups) !== JSON.stringify(plan.backups) || JSON.stringify(lockedPlan.links) !== JSON.stringify(plan.links)) {
      fail('target-changed', 'Skill entries changed after preflight.');
    }
    if (plan.backupRoot) { await io.mkdir(plan.backupRoot); createdBackup = true; }
    for (const item of plan.backups) {
      await checkTarget(plan, targetIdentity, io);
      const current = await io.lstat(item.path);
      if (current.isSymbolicLink() || identity(current) !== item.identity) fail('target-changed', 'Skill directory changed before backup.', { path: item.path });
      const backup = path.join(plan.backupRoot, item.name);
      await io.rename(item.path, backup);
      journal.push({ type: 'backup', original: item.path, backup, identity: item.identity });
    }
    if (plan.backupRoot && options.onBackup) await options.onBackup({ event: 'backup-created', path: plan.backupRoot, entries: plan.backups.map(item => item.name) });
    for (const item of plan.links) {
      await checkTarget(plan, targetIdentity, io);
      if (await statOrNull(item.destination, io)) fail('target-changed', 'A skill destination appeared during installation.', { path: item.destination });
      await io.symlink(item.source, item.destination, process.platform === 'win32' ? 'junction' : 'dir');
      const operation = { type: 'link', ...item, identity: null };
      journal.push(operation);
      operation.identity = identity(await io.lstat(item.destination));
    }
    return result;
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of journal.reverse()) {
      try {
        await checkTarget(plan, targetIdentity, io);
        if (operation.type === 'link') {
          const current = await io.lstat(operation.destination);
          if (!current.isSymbolicLink() || identity(current) !== operation.identity || !samePath(await io.realpath(operation.destination), operation.source)) {
            fail('rollback-conflict', 'Installed link was replaced; it will not be removed.', { path: operation.destination });
          }
          await io.unlink(operation.destination); // Unlinks only our exact junction/symlink, never its contents.
        } else {
          if (await statOrNull(operation.original, io)) fail('rollback-conflict', 'Original path was reused; backup has been preserved.', { path: operation.original });
          const backupInfo = await io.lstat(operation.backup);
          if (backupInfo.isSymbolicLink() || identity(backupInfo) !== operation.identity) fail('rollback-conflict', 'Backup identity changed; it has been preserved.', { path: operation.backup });
          await io.rename(operation.backup, operation.original);
        }
      } catch (rollbackError) { rollbackErrors.push(errorResult(rollbackError).error); }
    }
    if (createdBackup) {
      try { await io.rmdir(plan.backupRoot); } // Empty directory only; never recursively remove backups.
      catch (cleanupError) { if (!['ENOTEMPTY', 'EEXIST'].includes(cleanupError.code)) rollbackErrors.push(errorResult(cleanupError).error); }
    }
    if (createdTarget) {
      try { await checkTarget(plan, targetIdentity, io); await io.rmdir(plan.location.target); }
      catch (cleanupError) { rollbackErrors.push(errorResult(cleanupError).error); }
    }
    error.details = { ...error.details, backupRoot: plan.backupRoot, rollbackComplete: rollbackErrors.length === 0, rollbackErrors };
    throw error;
  } finally {
    if (lock) {
      await lock.close();
      const info = await statOrNull(lockPath, io);
      if (info && !info.isSymbolicLink() && identity(info) === lockIdentity && await readUtf8(lockPath, io) === lockToken) await io.unlink(lockPath);
    }
  }
}

export function parseInstallArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--target' && !options.target && args[index + 1] && !args[index + 1].startsWith('--')) options.target = args[++index];
    else if (argument === '--skill' && args[index + 1] && !args[index + 1].startsWith('--')) (options.skills ??= []).push(args[++index]);
    else if (argument === '--apply' && options.apply !== true) options.apply = true;
    else if (argument === '--migrate-legacy' && options.migrateLegacy !== true) options.migrateLegacy = true;
    else fail('invalid-arguments', 'Usage: node tools/install.mjs --target <dir> [--skill <name>] [--apply] [--migrate-legacy]');
  }
  if (!options.target) fail('target-required', 'Pass an explicit --target directory.');
  return options;
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    options.onBackup = event => process.stderr.write(`${JSON.stringify(event)}\n`);
    console.log(JSON.stringify(await installSkills(options), null, 2));
  }
  catch (error) { console.log(JSON.stringify(errorResult(error), null, 2)); process.exitCode = 1; }
}
