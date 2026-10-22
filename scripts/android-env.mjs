/**
 * Cross-platform helpers for Android / JDK discovery (Windows, macOS, Linux).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, '..');
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function androidSdk() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = isWin
    ? [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
        path.join(homeDir(), 'AppData', 'Local', 'Android', 'Sdk'),
        'C:\\Android\\Sdk',
      ]
    : isMac
      ? [
          path.join(homeDir(), 'Library', 'Android', 'sdk'),
          path.join(homeDir(), 'Android', 'Sdk'),
        ]
      : [
          path.join(homeDir(), 'Android', 'Sdk'),
          '/opt/android-sdk',
          '/usr/lib/android-sdk',
        ];

  return candidates.filter(Boolean).find((p) => existsSync(p)) || candidates.find(Boolean);
}

export function sdkBin(name) {
  const sdk = androidSdk();
  const file = isWin ? `${name}.exe` : name;
  return path.join(sdk, name === 'emulator' ? 'emulator' : 'platform-tools', file);
}

function javaMajor(javaHome) {
  const java = path.join(javaHome, 'bin', isWin ? 'java.exe' : 'java');
  if (!existsSync(java)) return null;
  const r = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const text = `${r.stderr || ''}${r.stdout || ''}`;
  const m = text.match(/version "(\d+)/);
  return m ? Number(m[1]) : null;
}

function looksLikeJdk(dir) {
  if (!dir || !existsSync(dir)) return false;
  const java = path.join(dir, 'bin', isWin ? 'java.exe' : 'java');
  const javac = path.join(dir, 'bin', isWin ? 'javac.exe' : 'javac');
  return existsSync(java) && existsSync(javac);
}

/** Expand a path whose last segment may contain `*` (e.g. jdk-21*). */
function expandGlob(entry) {
  if (!entry) return [];
  if (!entry.includes('*')) return [entry];

  const parts = entry.split(/[/\\]/);
  const starIdx = parts.findIndex((p) => p.includes('*'));
  if (starIdx < 0) return [entry];

  const parent = parts.slice(0, starIdx).join(path.sep) || path.sep;
  const pattern = parts[starIdx];
  const rest = parts.slice(starIdx + 1);
  if (!existsSync(parent)) return [];

  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
  return readdirSync(parent)
    .filter((name) => re.test(name))
    .map((name) => path.join(parent, name, ...rest));
}

function expandGlobs(dirs) {
  return dirs.flatMap(expandGlob);
}

function macJavaHome(version) {
  const r = spawnSync('/usr/libexec/java_home', ['-v', String(version)], {
    encoding: 'utf8',
  });
  if (r.status === 0) {
    const p = (r.stdout || '').trim();
    if (p) return p;
  }
  return null;
}

/**
 * Resolve a JDK 21 install. Override with JAVA_HOME (if 21) or TRAILCOMPASS_JAVA_HOME.
 */
export function resolveJdk21() {
  const override = process.env.TRAILCOMPASS_JAVA_HOME || process.env.CAPACITOR_JAVA_HOME;
  if (override && looksLikeJdk(override)) {
    const major = javaMajor(override);
    if (major === 21) return path.resolve(override);
    throw new Error(
      `TRAILCOMPASS_JAVA_HOME/CAPACITOR_JAVA_HOME must be JDK 21 (got ${major ?? 'unknown'}): ${override}`,
    );
  }

  if (process.env.JAVA_HOME && looksLikeJdk(process.env.JAVA_HOME) && javaMajor(process.env.JAVA_HOME) === 21) {
    return path.resolve(process.env.JAVA_HOME);
  }

  const candidates = [];

  if (isMac) {
    const fromTool = macJavaHome(21);
    if (fromTool) candidates.push(fromTool);
    candidates.push(
      ...expandGlobs([
        '/Library/Java/JavaVirtualMachines/temurin-21*/Contents/Home',
        '/Library/Java/JavaVirtualMachines/jdk-21*/Contents/Home',
        '/Library/Java/JavaVirtualMachines/zulu-21*/Contents/Home',
        path.join(homeDir(), 'Library/Java/JavaVirtualMachines/temurin-21*/Contents/Home'),
      ]),
    );
  } else if (isWin) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
    candidates.push(
      ...expandGlobs([
        path.join(pf, 'Eclipse Adoptium', 'jdk-21*'),
        path.join(pf, 'Java', 'jdk-21*'),
        path.join(pf, 'Microsoft', 'jdk-21*'),
        path.join(pf, 'Amazon Corretto', 'jdk21*'),
        path.join(local, 'Programs', 'Eclipse Adoptium', 'jdk-21*'),
        path.join(pf86, 'Eclipse Adoptium', 'jdk-21*'),
      ]),
    );
  } else {
    // Linux
    candidates.push(
      '/usr/lib/jvm/java-21-openjdk-amd64',
      '/usr/lib/jvm/java-21-openjdk',
      '/usr/lib/jvm/java-21-openjdk-arm64',
      ...expandGlobs([
        '/usr/lib/jvm/java-21*',
        '/usr/lib/jvm/jdk-21*',
        '/usr/lib/jvm/temurin-21*',
        path.join(homeDir(), 'jdks', 'jdk-21*'),
        path.join(homeDir(), '.sdkman/candidates/java', '21*'),
      ]),
    );
  }

  for (const dir of candidates) {
    // macOS .jdk bundles may need Contents/Home
    const homes = [dir, path.join(dir, 'Contents', 'Home')];
    for (const home of homes) {
      if (looksLikeJdk(home) && javaMajor(home) === 21) {
        return path.resolve(home);
      }
    }
  }

  throw new Error(
    [
      'JDK 21 with javac not found.',
      'Install a JDK 21, or set TRAILCOMPASS_JAVA_HOME (or JAVA_HOME) to that install.',
      'Linux: openjdk-21-jdk | macOS: brew install --cask temurin@21 | Windows: Eclipse Temurin 21',
    ].join('\n'),
  );
}

export function gradleWrapper() {
  return path.join(root, 'android', isWin ? 'gradlew.bat' : 'gradlew');
}

/**
 * Run the Android Gradle wrapper with JDK 21 forced (overrides ~/.gradle java.home).
 */
export function runGradle(args, opts = {}) {
  const jdk = resolveJdk21();
  const wrapper = gradleWrapper();
  if (!existsSync(wrapper)) {
    throw new Error(`Gradle wrapper missing: ${wrapper}. Run: npx cap add android`);
  }

  const gradleArgs = [...args, `-Dorg.gradle.java.home=${jdk}`];
  const env = {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: androidSdk(),
    ANDROID_SDK_ROOT: androidSdk(),
  };

  // Ensure platform-tools on PATH for any Gradle Android tasks that shell out.
  const sdk = androidSdk();
  const extraPath = [
    path.join(sdk, 'platform-tools'),
    path.join(sdk, 'emulator'),
    path.join(jdk, 'bin'),
  ].join(path.delimiter);
  env.PATH = `${extraPath}${path.delimiter}${process.env.PATH || ''}`;

  console.log(`Using JDK 21: ${jdk}`);

  const result = spawnSync(wrapper, gradleArgs, {
    cwd: path.join(root, 'android'),
    env,
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}
