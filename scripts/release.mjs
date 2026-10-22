#!/usr/bin/env node
/**
 * Bump the app version, build a debug APK, and publish it as a GitHub Release.
 *
 * Usage:
 *   node scripts/release.mjs minor
 *   node scripts/release.mjs major
 *   node scripts/release.mjs minor --notes "Offline map download"
 *   node scripts/release.mjs major --draft
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { root, runGradle } from './android-env.mjs';

const bump = process.argv[2];
const notesFlag = process.argv.indexOf('--notes');
const notes = notesFlag >= 0 ? process.argv[notesFlag + 1] : '';
const draft = process.argv.includes('--draft');

if (bump !== 'minor' && bump !== 'major') {
  console.error('Usage: node scripts/release.mjs <minor|major> [--notes "..."] [--draft]');
  process.exit(1);
}
if (notesFlag >= 0 && !notes) {
  console.error('--notes requires a message');
  process.exit(1);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const gradlePath = path.join(root, 'android/app/build.gradle');
const configPath = path.join(root, 'android/app/src/main/res/xml/config.xml');
const apkPath = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');

const status = git(['status', '--porcelain']);
if (status) {
  console.error('Working tree is not clean. Commit or stash changes before releasing.');
  console.error(status);
  process.exit(1);
}

try {
  git(['remote', 'get-url', 'origin']);
} catch {
  console.error('No git remote named origin. Add the GitHub remote before releasing.');
  process.exit(1);
}

try {
  execFileSync('gh', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('GitHub CLI (gh) is not installed or not on PATH.');
  process.exit(1);
}

const previous = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
run('npm', ['version', bump, '--no-git-tag-version']);
const next = JSON.parse(readFileSync(pkgPath, 'utf8')).version;

let gradle = readFileSync(gradlePath, 'utf8');
const codeMatch = gradle.match(/versionCode\s+(\d+)/);
if (!codeMatch) {
  console.error('versionCode not found in android/app/build.gradle');
  process.exit(1);
}
const nextCode = Number(codeMatch[1]) + 1;
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${nextCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${next}"`);
writeFileSync(gradlePath, gradle);

let config = readFileSync(configPath, 'utf8');
if (!config.includes('<widget version="')) {
  console.error('widget version not found in android/app/src/main/res/xml/config.xml');
  process.exit(1);
}
config = config.replace(/<widget version="[^"]*"/, `<widget version="${next}"`);
writeFileSync(configPath, config);

console.log(`Version ${previous} -> ${next} (versionCode ${nextCode})`);

console.log('Building debug APK…');
run('npm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);
runGradle(['assembleDebug']);

if (!existsSync(apkPath)) {
  console.error(`APK not found: ${apkPath}`);
  process.exit(1);
}

const tag = `v${next}`;
const message = notes || `Release ${tag}`;
const versioned = ['package.json', 'android/app/build.gradle', 'android/app/src/main/res/xml/config.xml'];
if (existsSync(lockPath)) versioned.push('package-lock.json');

run('git', ['add', ...versioned]);
run('git', ['commit', '-m', message]);
run('git', ['tag', tag]);
run('git', ['push', '-u', 'origin', 'HEAD']);
run('git', ['push', 'origin', tag]);

const releaseArgs = [
  'release', 'create', tag,
  apkPath,
  '--title', `TrailCompass ${tag}`,
  '--notes', message,
];
if (draft) releaseArgs.push('--draft');
run('gh', releaseArgs);

const url = execFileSync('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
console.log(`Published ${tag}`);
console.log(url);
