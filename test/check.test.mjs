import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkRepository } from '../tools/check.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-check-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ schemaVersion: 1, skills: [{ name: 'fw-one', legacyNames: ['old-one'] }] }));
  const skillRoot = path.join(root, 'skills', 'fw-one');
  await fs.mkdir(path.join(skillRoot, 'agents'), { recursive: true });
  await fs.mkdir(path.join(skillRoot, 'references'));
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: fw-one\ndescription: A complete fixture.\n---\n# One\nRead [guide](references/guide.md).\n');
  await fs.writeFile(path.join(skillRoot, 'references', 'guide.md'), '# Guide\nA legitimate discussion of TODO and FIXME markers.\n');
  await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  default_prompt: "Use $fw-one to inspect this."\n');
  return { root, skillRoot };
}

test('valid catalog, identities, UTF-8, UI prompt and relative references pass', async t => {
  const { root } = await fixture(t);
  const result = await checkRepository(root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.statistics, { skills: 1, files: 4, documents: 4, references: 1 });
});

test('missing Markdown and explicit packaged script references fail', async t => {
  const { root, skillRoot } = await fixture(t);
  await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nRun `scripts/missing.mjs`.\n');
  let result = await checkRepository(root);
  assert.ok(result.errors.some(error => error.code === 'missing-reference' && error.reference === 'scripts/missing.mjs'));
  await fs.unlink(path.join(skillRoot, 'references', 'guide.md'));
  result = await checkRepository(root);
  assert.ok(result.errors.some(error => error.code === 'missing-reference' && error.reference === 'references/guide.md'));
});

test('references outside source and malformed URL escapes fail', async t => {
  const { root, skillRoot } = await fixture(t);
  await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\n[escape](../../../outside.md)\n');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'reference-outside-source'));
  await fs.writeFile(path.join(skillRoot, 'references', 'guide.md'), '[invalid](bad%ZZ.md)');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'invalid-reference'));
});

test('mismatched frontmatter name and UI name fail independently', async t => {
  const { root, skillRoot } = await fixture(t);
  await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  default_prompt: "Use $old-one."\n');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'prompt-identity-mismatch'));
  const filename = path.join(skillRoot, 'SKILL.md');
  await fs.writeFile(filename, (await fs.readFile(filename, 'utf8')).replace('name: fw-one', 'name: not-one'));
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'identity-mismatch'));
});

test('invalid UTF-8 documentation and explicit unfinished placeholders fail', async t => {
  const { root, skillRoot } = await fixture(t);
  const guide = path.join(skillRoot, 'references', 'guide.md');
  await fs.writeFile(guide, Buffer.from([0x66, 0x80]));
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'invalid-utf8'));
  await fs.writeFile(guide, '[TODO: finish this guide]');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'unfinished-placeholder'));
});

test('uncatalogued source entries and source symlinks are rejected', async t => {
  const { root, skillRoot } = await fixture(t);
  await fs.mkdir(path.join(root, 'skills', 'unknown'));
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'uncatalogued-entry'));
  await fs.symlink(path.join(skillRoot, 'references'), path.join(skillRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'source-link'));
});

test('invalid schema, duplicate aliases and malformed catalog JSON fail closed', async t => {
  const { root } = await fixture(t);
  for (const value of [JSON.stringify({ schemaVersion: 2, skills: [] }), JSON.stringify({ schemaVersion: 1, skills: [{ name: 'fw-one', legacyNames: ['fw-one'] }] }), '{bad json']) {
    await fs.writeFile(path.join(root, 'catalog.json'), value);
    const result = await checkRepository(root);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'invalid-catalog');
  }
});

test('folded YAML descriptions/prompts and reference definitions are supported', async t => {
  const { root, skillRoot } = await fixture(t);
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: fw-one\ndescription: >-\n  A folded\n  description.\n---\nRead [guide][g].\n[g]: references/guide.md\n');
  await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  default_prompt: >-\n    Use $fw-one\n    to inspect.\n');
  const result = await checkRepository(root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statistics.references, 1);
});

test('duplicate identity and UI fields do not receive ambiguous YAML interpretations', async t => {
  const { root, skillRoot } = await fixture(t);
  const yaml = path.join(skillRoot, 'agents', 'openai.yaml');
  await fs.appendFile(yaml, '  default_prompt: "Use $old-one."\n');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'invalid-ui-metadata'));
  const filename = path.join(skillRoot, 'SKILL.md');
  await fs.writeFile(filename, (await fs.readFile(filename, 'utf8')).replace('name: fw-one', 'name: fw-one\nname: old-one'));
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'invalid-frontmatter'));
});

test('repository README references and UTF-8 are also checked', async t => {
  const { root } = await fixture(t);
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '[one](skills/fw-one/SKILL.md)\n');
  assert.equal((await checkRepository(root)).ok, true);
  await fs.writeFile(readme, '[missing](skills/absent/SKILL.md)\n');
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'missing-reference' && error.path === readme));
  await fs.writeFile(readme, Buffer.from([0xc3, 0x28]));
  assert.ok((await checkRepository(root)).errors.some(error => error.code === 'invalid-utf8' && error.path === readme));
});
