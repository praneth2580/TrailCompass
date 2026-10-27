import { describe, expect, it } from 'vitest';
import { DownloadPolicyService } from './download-policy.service';

function wifiOnlyOnMobileData() {
  const policy = new DownloadPolicyService();
  policy.setSetting('wifi');
  policy.setNetwork('cellular');
  return policy;
}

/** Whether `promise` has settled after pending callbacks ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe('DownloadPolicyService', () => {
  it('holds downloads only on mobile data with Wi-Fi only', () => {
    const policy = new DownloadPolicyService();
    expect(policy.getSetting()).toBe('any');
    policy.setNetwork('cellular');
    expect(policy.canDownload()).toBe(true);

    policy.setSetting('wifi');
    expect(policy.canDownload()).toBe(false);
    for (const network of ['wifi', 'other', 'none', 'unknown'] as const) {
      policy.setNetwork(network);
      expect(policy.canDownload()).toBe(true);
    }
  });

  it('lets road downloads wait until Wi-Fi connects', async () => {
    const policy = wifiOnlyOnMobileData();
    const waiting = policy.waitForRoads();
    expect(await settled(waiting)).toBe(false);
    expect(policy.isWaiting()).toBe(true);

    policy.setNetwork('wifi');
    await waiting;
    expect(policy.isWaiting()).toBe(false);
  });

  it('stops waiting when mobile data is allowed', async () => {
    const policy = wifiOnlyOnMobileData();
    const waiting = policy.waitForRoads();
    policy.setSetting('any');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('never makes a rerouting rider wait', async () => {
    const policy = wifiOnlyOnMobileData();
    policy.setRiding(true);
    expect(await settled(policy.waitForRoads())).toBe(true);
    expect(policy.isWaiting()).toBe(false);
  });

  it('gives up when planning is cancelled', async () => {
    const policy = wifiOnlyOnMobileData();
    const abort = new AbortController();
    const waiting = policy.waitForRoads(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(policy.isWaiting()).toBe(false);
  });
});
