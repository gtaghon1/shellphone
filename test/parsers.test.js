import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Tests run against the build output; `npm test` assumes `npm run build` ran.
const { formatDigest, parseLedger, makeDigest, appendDigest, readDigests, hasDigestForSession } =
  await import('../dist/ledger.js');
const { parseInbox, appendInstruction, pending, consumeInstruction, takeUnannounced, takeAllPending } =
  await import('../dist/queue.js');
const { ago, truncate, gitDirtyFiles } = await import('../dist/format.js');
const { relativeToRepo, normalizeChanged } = await import('../dist/paths.js');
const { computeDrift, driftNotice } = await import('../dist/drift.js');
const { parseManifest, formatManifest, readManifest, writeManifest, manifestAge } =
  await import('../dist/manifest.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellphone-test-'));
  fs.mkdirSync(path.join(dir, '.shellphone', 'queue'), { recursive: true });
  return dir;
}

// ---- ledger ---------------------------------------------------------------

test('digest survives a format → parse round trip', () => {
  const d = makeDigest({
    repo: 'bitlattice',
    branch: 'gibbs-relax-v2',
    machine: 'box.local',
    session: 'sess-1',
    status: 'needs-input',
    summary: 'Implemented the kernel. Blocked on schedule choice.',
    changed: ['src/relax.c', 'src/lattice.h'],
    next_decision: 'fixed vs adaptive temperature schedule',
    open_questions: ['does adaptive need its own PRNG stream?'],
  });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], d);
});

test('summaries with YAML-hostile characters round trip intact', () => {
  // The digest is model-written prose; it will contain colons, quotes, and
  // hashes. If YAML quoting is wrong here the whole ledger silently corrupts.
  const nasty = 'Fixed: "the #1 bug" — see {a: b}, [c], 80% @ 3x\nsecond line\ttabbed';
  const d = makeDigest({ repo: 'r', summary: nasty, status: 'wip' });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed[0].summary, nasty);
});

test('a code fence inside a summary does not truncate the entry', () => {
  const d = makeDigest({ repo: 'r', status: 'wip', summary: 'like ```yaml\nx: 1\n``` inline' });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].summary, d.summary);
});

test('unknown status degrades to wip rather than throwing', () => {
  const parsed = parseLedger('```yaml\nts: t\nrepo: r\nstatus: bogus\nsummary: s\n```');
  assert.equal(parsed[0].status, 'wip');
});

test('a hand-mangled entry is skipped, not fatal', () => {
  const good = formatDigest(makeDigest({ repo: 'r', status: 'wip', summary: 'fine' }));
  const bad = '\n## broken\n\n```yaml\n: : not yaml : :\n  - [\n```\n';
  const parsed = parseLedger(bad + good);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].summary, 'fine');
});

test('entries with no ts or summary are not treated as digests', () => {
  assert.equal(parseLedger('```yaml\nrepo: r\n```').length, 0);
});

test('ledger appends in order and tracks sessions', () => {
  const dir = tmpRepo();
  appendDigest(dir, makeDigest({ repo: 'r', status: 'wip', summary: 'one', session: 'a' }));
  appendDigest(dir, makeDigest({ repo: 'r', status: 'shipped', summary: 'two', session: 'b' }));
  const all = readDigests(dir);
  assert.deepEqual(all.map((d) => d.summary), ['one', 'two']);
  assert.ok(hasDigestForSession(dir, 'a'));
  assert.ok(!hasDigestForSession(dir, 'c'));
  // No session id must never count as "already digested".
  assert.ok(!hasDigestForSession(dir, ''));
  assert.match(fs.readFileSync(path.join(dir, '.shellphone', 'state.md'), 'utf8'), /^# shellphone ledger/);
});

// ---- queue ----------------------------------------------------------------

test('instruction round trips, including markdown in the body', () => {
  const dir = tmpRepo();
  const body = '## Use adaptive\n\n- seed from state hash\n- keep `--fixed` as a fallback';
  const inst = appendInstruction(dir, body, 'r');
  const [got] = pending(dir);
  assert.equal(got.id, inst.id);
  assert.equal(got.text, body);
  assert.equal(got.consumed, undefined);
});

test('consuming an instruction is idempotent and id-scoped', () => {
  const dir = tmpRepo();
  const a = appendInstruction(dir, 'first', 'r');
  const b = appendInstruction(dir, 'second', 'r');
  assert.ok(consumeInstruction(dir, a.id));
  assert.equal(consumeInstruction(dir, a.id), null, 'second consume is a no-op');
  assert.deepEqual(pending(dir).map((i) => i.id), [b.id]);
  assert.equal(consumeInstruction(dir, 'nosuch'), null);
});

test('takeUnannounced delivers each instruction exactly once', () => {
  const dir = tmpRepo();
  appendInstruction(dir, 'one', 'r');
  assert.equal(takeUnannounced(dir).length, 1);
  assert.equal(takeUnannounced(dir).length, 0, 'already announced');
  appendInstruction(dir, 'two', 'r');
  assert.deepEqual(takeUnannounced(dir).map((i) => i.text), ['two']);
});

test('takeAllPending re-announces work that was seen but never acted on', () => {
  // The case that matters: a session saw an instruction, then died without
  // acting. The next session still owes the user that instruction.
  const dir = tmpRepo();
  const a = appendInstruction(dir, 'one', 'r');
  takeUnannounced(dir);
  assert.deepEqual(takeAllPending(dir).map((i) => i.id), [a.id]);
  consumeInstruction(dir, a.id);
  assert.deepEqual(takeAllPending(dir), []);
});

test('inbox parser tolerates a hand-written file', () => {
  const parsed = parseInbox(
    '# shellphone inbox — r\n\n## pending · aa11bb · sent 2026-01-01T00:00:00Z\n\nhand written\n',
  );
  assert.deepEqual(parsed, [
    { id: 'aa11bb', sent: '2026-01-01T00:00:00Z', consumed: undefined, text: 'hand written' },
  ]);
});

// ---- changed-path scoping (regression: instruction 3880ea) ----------------

test('absolute paths inside the repo become repo-relative', () => {
  const dir = tmpRepo();
  assert.equal(relativeToRepo(dir, path.join(dir, 'src', 'ledger.ts')), 'src/ledger.ts');
  assert.equal(relativeToRepo(dir, 'src/ledger.ts'), 'src/ledger.ts', 'already-relative is a no-op');
});

test('paths outside the repo root are rejected', () => {
  const dir = tmpRepo();
  const outside = tmpRepo();
  assert.equal(relativeToRepo(dir, path.join(outside, 'scratch.mjs')), null);
  assert.equal(relativeToRepo(dir, '/etc/passwd'), null);
  assert.equal(relativeToRepo(dir, '../escape.ts'), null);
  assert.equal(relativeToRepo(dir, dir), null, 'the root itself is not a changed file');
});

test('a repo reached through a symlink still owns its own files', () => {
  // macOS resolves /tmp to /private/tmp; without realpath handling every file
  // in a tmpdir-based repo would look like it escaped the root.
  const dir = tmpRepo();
  const link = path.join(os.tmpdir(), `shellphone-link-${process.pid}`);
  try {
    fs.symlinkSync(dir, link, 'dir');
    assert.equal(relativeToRepo(link, path.join(dir, 'src/a.ts')), 'src/a.ts');
    assert.equal(relativeToRepo(dir, path.join(link, 'src/a.ts')), 'src/a.ts');
  } finally {
    fs.unlinkSync(link); // a symlink to a directory: unlink, not rm
  }
});

test('normalizeChanged drops escapees, dedupes, and hides our own files', () => {
  const dir = tmpRepo();
  const outside = tmpRepo();
  assert.deepEqual(
    normalizeChanged(dir, [
      path.join(dir, 'src/b.ts'),
      'src/a.ts',
      path.join(dir, 'src/a.ts'), // same file, two spellings
      path.join(outside, 'scratchpad/mcpclient.mjs'), // the leak
      path.join(dir, '.shellphone/state.md'), // self-referential noise
      '',
    ]),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('normalizeChanged bounds the list', () => {
  const dir = tmpRepo();
  const many = Array.from({ length: 60 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
  assert.equal(normalizeChanged(dir, many, 25).length, 25);
});

test('a digest written with absolute paths lands relative in the ledger', () => {
  // The end-to-end invariant the instruction actually asked for.
  const dir = tmpRepo();
  const outside = tmpRepo();
  appendDigest(
    dir,
    makeDigest({
      repo: 'r',
      status: 'wip',
      summary: 'x',
      changed: normalizeChanged(dir, [
        path.join(dir, 'src/hooks.ts'),
        path.join(outside, 'scratch.mjs'),
      ]),
    }),
  );
  const [d] = readDigests(dir);
  assert.deepEqual(d.changed, ['src/hooks.ts']);
  assert.ok(!fs.readFileSync(path.join(dir, '.shellphone/state.md'), 'utf8').includes(outside));
});

// ---- manifest (instruction e32365) ----------------------------------------

test('manifest survives a format → parse round trip', () => {
  const m = {
    name: 'redline',
    one_liner: 'A racing sim with a deterministic physics core.',
    purpose: 'Explores fixed-timestep determinism for replay and netcode.',
    stack: ['C++20', 'CMake'],
    layout: [{ path: 'src/physics', role: 'fixed-timestep solver' }],
    entry_points: { build: 'cmake --build build', test: 'ctest' },
    decisions: [{ what: 'fixed 240Hz timestep', why: 'replay determinism' }],
    constraints: ['no networking in v1'],
    gotchas: ['the solver assumes SI units throughout'],
    open: ['tyre model: brush vs Pacejka'],
    surveyed: '2026-07-30T12:00:00Z',
    commit: 'abc1234',
    machine: 'box.local',
  };
  assert.deepEqual(parseManifest(formatManifest(m)), m);
});

test('a manifest with only the required fields round trips', () => {
  const m = { name: 'x', one_liner: 'y', surveyed: '2026-07-30T12:00:00Z' };
  const got = parseManifest(formatManifest(m));
  assert.equal(got.name, 'x');
  assert.equal(got.one_liner, 'y');
  assert.equal(got.stack, undefined, 'absent fields stay absent, not empty arrays');
});

test('a manifest missing identity is rejected outright', () => {
  // Without name + one_liner it cannot do its one job, so it is not a manifest.
  assert.equal(parseManifest('```yaml\nstack: [ts]\n```'), null);
  assert.equal(parseManifest('no fence here'), null);
  assert.equal(parseManifest('```yaml\n: : bad :\n  - [\n```'), null);
});

test('decisions accept bare strings as well as what/why pairs', () => {
  // Hand-editing is a supported path; a human will write a plain list.
  const m = parseManifest(
    '```yaml\nname: r\none_liner: o\ndecisions:\n  - just a string\n  - what: paired\n    why: because\n```',
  );
  assert.deepEqual(m.decisions, [{ what: 'just a string' }, { what: 'paired', why: 'because' }]);
});

test('manifest writes and reads back from disk, and overwrites', () => {
  const dir = tmpRepo();
  assert.equal(readManifest(dir), null);
  writeManifest(dir, { name: 'a', one_liner: 'first', surveyed: '2026-01-01T00:00:00Z' });
  writeManifest(dir, { name: 'a', one_liner: 'second', surveyed: '2026-01-02T00:00:00Z' });
  assert.equal(readManifest(dir).one_liner, 'second', 'refresh replaces, not appends');
  const raw = fs.readFileSync(path.join(dir, '.shellphone/manifest.md'), 'utf8');
  assert.ok(!raw.includes('first'), 'no stale copy left behind');
  assert.match(raw, /^# shellphone manifest/);
});

test('manifest and ledger live in separate files', () => {
  // The instruction's actual requirement: identity must not be conflated with
  // session digests, in either direction.
  const dir = tmpRepo();
  writeManifest(dir, { name: 'a', one_liner: 'ident', surveyed: '2026-01-01T00:00:00Z' });
  appendDigest(dir, makeDigest({ repo: 'a', status: 'wip', summary: 'a session happened' }));
  assert.equal(readManifest(dir).one_liner, 'ident');
  assert.equal(readDigests(dir).length, 1, 'manifest is not parsed as a digest');
  assert.ok(!fs.readFileSync(path.join(dir, '.shellphone/state.md'), 'utf8').includes('ident'));
});

test('manifest age reports commits since the surveyed rev', () => {
  const { dir, run } = gitRepo();
  const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const m = { name: 'a', one_liner: 'o', surveyed: new Date().toISOString(), commit: head };
  assert.equal(manifestAge(dir, m).commits, 0);
  fs.writeFileSync(path.join(dir, 'b.ts'), 'x');
  run('add', '-A');
  run('commit', '-qm', 'b');
  assert.equal(manifestAge(dir, m).commits, 1);
});

test('manifest age survives a rev that no longer exists', () => {
  // Rebased, or read from a fresh clone. Must not throw.
  const { dir } = gitRepo();
  const m = { name: 'a', one_liner: 'o', surveyed: new Date().toISOString(), commit: 'deadbee' };
  assert.equal(manifestAge(dir, m).commits, 0);
});

// ---- drift ----------------------------------------------------------------

const CFG = { staleFiles: 5, staleCommits: 2, staleMinutes: 45 };

function gitRepo() {
  const dir = tmpRepo();
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one');
  run('add', '-A');
  // Backdate the setup commit. Committing at test time would land *after* the
  // `since` values below and correctly register as drift, which would mean every
  // test measured the fixture instead of the thing under test.
  const old = '2020-01-01T00:00:00Z';
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
  });
  return { dir, run };
}

test('a repo nobody touched is fresh', () => {
  const { dir } = gitRepo();
  const d = computeDrift(dir, new Date().toISOString(), [], CFG);
  assert.equal(d.level, 'fresh');
  assert.equal(driftNotice(d), '', 'fresh must render no warning at all');
});

test('one edited file drifts but does not go stale', () => {
  const { dir } = gitRepo();
  const since = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'two');
  const d = computeDrift(dir, since, [], CFG);
  assert.equal(d.level, 'drifting');
  assert.deepEqual(d.files, ['a.ts']);
  assert.match(driftNotice(d), /^note: 1 file changed/);
});

test('crossing the file threshold goes stale', () => {
  const { dir } = gitRepo();
  const since = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < CFG.staleFiles; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), 'x');
  const d = computeDrift(dir, since, [], CFG);
  assert.equal(d.level, 'stale');
  assert.match(driftNotice(d), /STALE/);
});

test('commits count as drift even when the tree is clean', () => {
  // The gap that mtime alone would miss: edited *and* committed since the digest.
  const { dir, run } = gitRepo();
  const since = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < CFG.staleCommits; i++) {
    fs.writeFileSync(path.join(dir, `c${i}.ts`), 'x');
    run('add', '-A');
    run('commit', '-qm', `c${i}`);
  }
  const d = computeDrift(dir, since, [], CFG);
  assert.equal(d.files.length, 0, 'tree is clean');
  assert.ok(d.commits >= CFG.staleCommits);
  assert.equal(d.level, 'stale');
});

test('age alone never goes stale without movement', () => {
  // An old digest for a repo nobody has touched is still accurate.
  const { dir } = gitRepo();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(computeDrift(dir, since, [], CFG).level, 'fresh');
});

test('a small change plus enough age does go stale', () => {
  const { dir } = gitRepo();
  const since = new Date(Date.now() - CFG.staleMinutes * 60_000 - 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'two');
  assert.equal(computeDrift(dir, since, [], CFG).level, 'stale');
});

test('no digest at all is stale as soon as anything was touched', () => {
  const { dir } = gitRepo();
  assert.equal(computeDrift(dir, null, [], CFG).level, 'fresh', 'nothing touched yet');
  const d = computeDrift(dir, null, [path.join(dir, 'a.ts')], CFG);
  assert.equal(d.level, 'stale');
  assert.match(driftNotice(d), /no digest yet/);
});

test('a clean tree stays fresh even when the session touched files earlier', () => {
  // Regression: git returning "nothing dirty" was indistinguishable from git
  // being absent, so the fallback replayed every file the session ever touched
  // and the hook demanded a second digest seconds after the first.
  const { dir } = gitRepo();
  const since = new Date().toISOString();
  const touchedEarlier = [path.join(dir, 'a.ts')]; // committed before `since`
  const d = computeDrift(dir, since, touchedEarlier, CFG);
  assert.equal(d.level, 'fresh');
  assert.deepEqual(d.files, []);
});

test('the non-git fallback still ignores files older than the reference', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'old.ts'), 'x');
  const since = new Date(Date.now() + 1000).toISOString(); // reference in the future
  assert.equal(computeDrift(dir, since, [path.join(dir, 'old.ts')], CFG).level, 'fresh');
});

test('outside a git repo, drift falls back to reported files', () => {
  // Without this the non-git case reports fresh forever and never escalates.
  const dir = tmpRepo();
  const since = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
  const d = computeDrift(dir, since, [path.join(dir, 'a.ts')], CFG);
  assert.deepEqual(d.files, ['a.ts']);
  assert.equal(d.level, 'drifting');
});

// ---- format ---------------------------------------------------------------

test('ago renders coarse relative time', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const at = (s) => ago(new Date(now - s * 1000).toISOString(), now);
  assert.equal(at(5), '5s ago');
  assert.equal(at(120), '2m ago');
  assert.equal(at(7200), '2h ago');
  assert.equal(at(172800), '2d ago');
  assert.equal(ago('not-a-date'), 'unknown');
});

test('truncate flattens newlines so table rows stay one line', () => {
  assert.equal(truncate('a\nb   c', 20), 'a b c');
  assert.equal(truncate('abcdef', 4), 'abc…');
});
