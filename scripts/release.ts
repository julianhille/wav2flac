// SPDX-License-Identifier: 0BSD
// Release helper.
//
// `node scripts/release.ts prepare X.Y.Z` bumps the version in package.json,
// package-lock.json, Cargo.toml and Cargo.lock, turns `## [Unreleased]` in
// CHANGELOG.md into `## [X.Y.Z] - today` (with a fresh empty Unreleased
// section and updated compare links) and commits. It runs on a fresh
// `release/vX.Y.Z` branch at origin/main. It never tags or pushes; it prints
// the commands for that.
//
// `node scripts/release.ts check vX.Y.Z [NOTES]` is run by the release
// workflow: the tag must match every version, and CHANGELOG.md must have a
// dated, non-empty section with a link for it. The section body is written to
// NOTES (the GitHub release text).
//
// `node scripts/release.ts lint` checks the structure of CHANGELOG.md alone.
// CI runs it on every push: CHANGELOG.md merges with `merge=union`
// (.gitattributes), which never conflicts but can duplicate or reorder the
// `### ` headings, or leave bullets under the wrong one. `check` and
// `prepare` run the same check.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'https://github.com/julianhille/wav2flac';
// Strict SemVer without build metadata: no leading zeros, npm-normal form.
const NUM = '(?:0|[1-9]\\d*)';
const PRE = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?$`);

/** A problem to report to the user (no stack trace). */
class ReleaseError extends Error {}

/**
 * Throws with a message for the user.
 * @param msg what is wrong
 */
function fail(msg: string): never {
  throw new ReleaseError(msg);
}

/** Files `prepare` edits, restored when it fails. */
const EDITED = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock'];

/**
 * Compares two SemVer versions (build metadata is not used here).
 * @param a version
 * @param b version
 * @returns negative, zero or positive, like a sort comparator
 */
function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string[]] => {
    const [core = '', pre] = v.split(/-(.*)/s);
    return [core.split('.').map(Number), pre === undefined ? [] : pre.split('.')];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return (ca[i] ?? 0) - (cb[i] ?? 0);
  // A release sorts after its prereleases.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i]!, pb[i]!];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/**
 * The versions that have a dated headline in the changelog, newest first.
 * @param log CHANGELOG.md
 * @returns the versions
 */
function releasedVersions(log: string): string[] {
  return [...log.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/gm)].map((m) => m[1]!);
}

const read = (f: string): string => readFileSync(f, 'utf8');
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The versions recorded in every manifest. */
function versions(): Record<string, string | undefined> {
  const lock = JSON.parse(read('package-lock.json'));
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
    'Cargo.toml': /^version = "([^"]+)"/m.exec(read('Cargo.toml'))?.[1],
    'Cargo.lock': /\[\[package\]\]\nname = "wav2flac"\nversion = "([^"]+)"/.exec(
      read('Cargo.lock'),
    )?.[1],
  };
}

/** The Keep a Changelog change types, in the order they are listed in. */
const TYPES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/**
 * Checks the structure of the changelog: each `## ` section lists its `### `
 * headings from `TYPES`, in that order and at most once each, and every
 * bullet is under one. A `merge=union` merge of two branches that both add
 * to `[Unreleased]` breaks one of these when it goes wrong; a bullet that
 * landed under the wrong existing heading it cannot catch.
 * @param log CHANGELOG.md
 */
function lint(log: string): void {
  let section: string | undefined;
  let last = -1;
  const where = (line: number, msg: string): never =>
    fail(`CHANGELOG.md:${line}: ${msg} (a merge=union artefact? see .gitattributes)`);
  log.split('\n').forEach((text, i) => {
    const line = i + 1;
    if (text.startsWith('## ')) {
      section = text.slice(3);
      last = -1;
    } else if (section === undefined) {
      // The preamble before the first section.
    } else if (text.startsWith('### ')) {
      const type = text.slice(4);
      const index = TYPES.indexOf(type);
      if (index < 0) where(line, `"${text}" is not one of ${TYPES.join(', ')}`);
      if (index === last) where(line, `${section} has "${text}" twice`);
      if (index < last) where(line, `${section} has "${text}" after "### ${TYPES[last]}"`);
      last = index;
    } else if (/^[-*] /.test(text) && last < 0) {
      where(line, `${section} has a bullet before its first "### " heading`);
    }
  });
}

/**
 * The body of a version's changelog section.
 * @param log CHANGELOG.md
 * @param v version
 * @returns the text between its headline and the next one
 */
function section(log: string, v: string): string {
  const head = new RegExp(`^## \\[${escape(v)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(log);
  if (head === null) fail(`CHANGELOG.md has no "## [${v}] - YYYY-MM-DD" headline`);
  const rest = log.slice(head.index + head[0].length);
  const end = rest.search(/^## /m);
  // The last section is followed by the version links; bodies may use
  // reference links of their own, so only trailing version links are cut.
  const lines = (end < 0 ? rest : rest.slice(0, end)).split('\n');
  const versionLink = new RegExp(`^\\[(Unreleased|\\d[^\\]]*)\\]: ${escape(REPO)}/`);
  while (lines.length > 0 && (lines.at(-1)!.trim() === '' || versionLink.test(lines.at(-1)!)))
    lines.pop();
  const body = lines.join('\n').trim();
  if (body === '') fail(`the CHANGELOG.md section for ${v} is empty`);
  if (!new RegExp(`^\\[${escape(v)}\\]: ${escape(REPO)}/`, 'm').test(log)) {
    fail(`CHANGELOG.md has no link line "[${v}]: ${REPO}/…"`);
  }
  return body;
}

/**
 * Checks a release tag against the manifests and the changelog.
 * @param tag `vX.Y.Z`
 * @param notes where to write the release notes, if anywhere
 */
function check(tag: string, notes?: string): void {
  if (!tag.startsWith('v') || !SEMVER.test(tag.slice(1))) fail(`${tag} is not vX.Y.Z[-pre]`);
  const v = tag.slice(1);
  for (const [file, got] of Object.entries(versions())) {
    if (got !== v) fail(`${file} has version ${got ?? '(none)'}, the tag says ${v}`);
  }
  const log = read('CHANGELOG.md');
  lint(log);
  const body = section(log, v);
  if (notes !== undefined) writeFileSync(notes, `${body}\n`);
  console.log(`release: ${tag} is consistent`);
}

/**
 * Bumps every version, dates the changelog and commits.
 * @param v the new version
 */
function prepare(v: string): void {
  if (!SEMVER.test(v)) fail(`${v} is not X.Y.Z[-pre]`);
  if (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }) !==
    ''
  ) {
    fail('the working tree has uncommitted changes');
  }
  const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
  // The release commit goes on its own branch, which is tagged and then
  // merged into main (see .github/workflows/release.yml).
  const branch = `release/v${v}`;
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== branch) {
    fail(`releases are prepared on ${branch}: git switch -c ${branch} origin/main`);
  }
  git('fetch', '--quiet', '--tags', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    fail(`${branch} is not at origin/main; start it from there`);
  }
  const log = read('CHANGELOG.md');
  lint(log);
  const prev = releasedVersions(log).reduce<string | undefined>(
    (a, b) => (a === undefined || compareVersions(b, a) > 0 ? b : a),
    undefined,
  );
  if (prev !== undefined && compareVersions(v, prev) <= 0) fail(`${v} is not newer than ${prev}`);
  // The headline links to compare/vPREV...vX. GitHub diffs from the merge
  // base, so a tag outside main's history (a squash-merged release branch)
  // gives a link that is not "everything since PREV".
  if (prev !== undefined) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', `refs/tags/v${prev}`, 'HEAD'], {
        stdio: 'ignore',
      });
    } catch {
      fail(
        `tag v${prev} is missing or not in main's history; merge release/v${prev} ` +
          `into main with a merge commit (not a squash) first`,
      );
    }
  }
  if (releasedVersions(log).includes(v) || new RegExp(`^\\[${escape(v)}\\]: `, 'm').test(log)) {
    fail(`CHANGELOG.md already has ${v}`);
  }
  try {
    execFileSync('git', ['rev-parse', '--quiet', '--verify', `refs/tags/v${v}`], {
      stdio: 'ignore',
    });
    fail(`tag v${v} already exists`);
  } catch (e) {
    if (e instanceof ReleaseError) throw e;
  }
  // The local date: the day the release is made where it is made.
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'))
    .join('-');
  const unreleased = /^## \[Unreleased\]$/m;
  if (!unreleased.test(log)) fail('CHANGELOG.md has no "## [Unreleased]" section');
  if (!/^\[Unreleased\]: /m.test(log)) fail('CHANGELOG.md has no "[Unreleased]: …" link');
  const links = log
    .replace(
      /^\[Unreleased\]: .*$/m,
      `[Unreleased]: ${REPO}/compare/v${v}...HEAD\n` +
        `[${v}]: ${prev !== undefined ? `${REPO}/compare/v${prev}...v${v}` : `${REPO}/releases/tag/v${v}`}`,
    )
    .replace(unreleased, `## [Unreleased]\n\n## [${v}] - ${date}`);
  section(links, v);

  try {
    writeFileSync('CHANGELOG.md', links);
    const pkg = read('package.json').replace(/("version": )"[^"]+"/, `$1"${v}"`);
    writeFileSync('package.json', pkg);
    const cargo = read('Cargo.toml').replace(/^version = "[^"]+"/m, `version = "${v}"`);
    writeFileSync('Cargo.toml', cargo);
    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { stdio: 'inherit' },
    );
    execFileSync('cargo', ['update', '--workspace', '--quiet'], { stdio: 'inherit' });
    check(`v${v}`);
    execFileSync('git', ['commit', '--quiet', '-am', `Release ${v}`], { stdio: 'inherit' });
  } catch (e) {
    // Leave the tree as it was (it was clean before).
    execFileSync('git', ['checkout', '--', ...EDITED], { stdio: 'inherit' });
    throw e;
  }
  // A merge commit (not a squash) keeps the tag in main's history, so the next
  // release's compare link starts at an ancestor.
  console.log(
    `release: committed. Review, then:\n` +
      `  git tag -a v${v} -m v${v}\n` +
      `  git push origin release/v${v} v${v}\n` +
      `and merge release/v${v} into main with a merge commit (not a squash).`,
  );
}

const [cmd, arg, notes] = process.argv.slice(2);
try {
  if (cmd === 'check' && arg !== undefined) check(arg, notes);
  else if (cmd === 'prepare' && arg !== undefined) prepare(arg);
  else if (cmd === 'lint' && arg === undefined) lint(read('CHANGELOG.md'));
  else {
    fail(
      'usage: release.ts prepare X.Y.Z | release.ts check vX.Y.Z [NOTES] | ' + 'release.ts lint',
    );
  }
} catch (e) {
  if (!(e instanceof ReleaseError)) throw e;
  console.error(`release: ${e.message}`);
  process.exitCode = 1;
}
