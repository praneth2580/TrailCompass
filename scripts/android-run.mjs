#!/usr/bin/env node
/**
 * Ensure an Android target (phone or emulator) is online, then install
 * (and optionally launch) the debug APK. Starts the default AVD when none
 * is connected. Works on Windows, macOS, and Linux.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { androidSdk, isWin, root, sdkBin } from './android-env.mjs';

const sdk = androidSdk();
const adb = sdkBin('adb');
const emulatorBin = sdkBin('emulator');
const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const appId = 'com.example.trailcompass';
const defaultAvd = process.env.ANDROID_AVD || 'Pixel_3a_API_34_extension_level_7_x86_64';

const mode = process.argv[2] || 'install'; // start | wait | install | run

function pathWithSdk() {
  return [
    path.join(sdk, 'platform-tools'),
    path.join(sdk, 'emulator'),
    process.env.PATH || '',
  ].join(path.delimiter);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, PATH: pathWithSdk() },
    shell: isWin,
    ...opts,
  });
}

function adbOut(...args) {
  const r = run(adb, args);
  if (r.error) throw r.error;
  return (r.stdout || '') + (r.stderr || '');
}

function listDevices() {
  const out = adbOut('devices');
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((d) => d.serial && d.state === 'device');
}

function listAvds() {
  if (!existsSync(emulatorBin)) return [];
  const r = run(emulatorBin, ['-list-avds']);
  return (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickAvd() {
  const avds = listAvds();
  if (avds.includes(defaultAvd)) return defaultAvd;
  if (avds.length) return avds[0];
  return null;
}

function startEmulator(avd) {
  console.log(`Starting emulator: ${avd}`);
  const child = spawn(
    emulatorBin,
    ['-avd', avd, '-netdelay', 'none', '-netspeed', 'full'],
    {
      detached: true,
      stdio: 'ignore',
      shell: isWin,
      env: {
        ...process.env,
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        PATH: pathWithSdk(),
      },
    },
  );
  child.unref();
}

function sleep(ms) {
  const seconds = String(Math.max(1, Math.ceil(ms / 1000)));
  if (isWin) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${seconds}`]);
  } else {
    spawnSync('sleep', [seconds]);
  }
}

function waitForDevice(timeoutMs = 180_000) {
  const start = Date.now();
  console.log('Waiting for Android device/emulator...');
  while (Date.now() - start < timeoutMs) {
    const devices = listDevices();
    if (devices.length) {
      for (const d of devices) {
        const boot = adbOut('-s', d.serial, 'shell', 'getprop', 'sys.boot_completed').trim();
        if (boot === '1') {
          console.log(`Ready: ${d.serial}`);
          return d.serial;
        }
      }
    }
    sleep(2000);
  }
  throw new Error('Timed out waiting for a booted Android device or emulator.');
}

function ensureTarget() {
  const existing = listDevices();
  if (existing.length) {
    console.log(`Using connected target: ${existing[0].serial}`);
    return waitForDevice(60_000);
  }

  if (!existsSync(emulatorBin)) {
    throw new Error(`No device connected and emulator not found at ${emulatorBin}`);
  }

  const avd = pickAvd();
  if (!avd) {
    throw new Error(
      'No device connected and no Android Virtual Devices found. Create one with avdmanager.',
    );
  }

  startEmulator(avd);
  return waitForDevice();
}

function installApk(serial) {
  if (!existsSync(apk)) {
    throw new Error(`APK not found: ${apk}\nRun: npm run cap:build`);
  }
  console.log(`Installing ${apk}`);
  const r = run(adb, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function launchApp(serial) {
  console.log(`Launching ${appId}`);
  const r = run(
    adb,
    ['-s', serial, 'shell', 'am', 'start', '-n', `${appId}/.MainActivity`],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    run(adb, ['-s', serial, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], {
      stdio: 'inherit',
    });
  }
}

try {
  if (!existsSync(adb)) {
    throw new Error(`adb not found at ${adb}. Set ANDROID_HOME / ANDROID_SDK_ROOT.`);
  }

  if (mode === 'start') {
    const avd = pickAvd();
    if (!avd) throw new Error('No AVDs found.');
    startEmulator(avd);
    waitForDevice();
    process.exit(0);
  }

  if (mode === 'wait') {
    waitForDevice();
    process.exit(0);
  }

  const serial = ensureTarget();
  if (mode === 'install' || mode === 'run') {
    installApk(serial);
  }
  if (mode === 'run') {
    launchApp(serial);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
