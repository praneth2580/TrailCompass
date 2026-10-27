// Progressive enhancement for the landing page; it works without this file.
// Download links default to GitHub's latest-release page.
const REPO = 'praneth2580/TrailCompass';

/** Point every download button straight at the newest APK, with its version and size. */
async function showLatestRelease() {
  const release = (await siteRelease()) ?? (await githubRelease());
  if (!release) return; // Offline or rate-limited: the links still open the release page.

  for (const link of document.querySelectorAll('[data-download]')) {
    link.href = release.url;
  }
  const megabytes = (release.size / 1_000_000).toFixed(1);
  for (const meta of document.querySelectorAll('[data-release-meta]')) {
    meta.textContent = `${release.tag} · ${megabytes} MB · Android 6.0+`;
  }
  for (const version of document.querySelectorAll('[data-release-version]')) {
    version.textContent = release.tag;
  }
}

/**
 * The APK this site serves (download/latest.json, published with each
 * release). Downloads from GitHub itself are slow or stall on many mobile
 * networks; this site is served through a CDN.
 */
async function siteRelease() {
  try {
    const response = await fetch('download/latest.json', { cache: 'no-cache' });
    if (!response.ok) return null;
    const latest = await response.json();
    if (typeof latest.apk !== 'string' || !/^download\/[A-Za-z0-9._-]+\.apk$/.test(latest.apk)) {
      return null;
    }
    return { url: new URL(latest.apk, document.baseURI).href, tag: latest.tag, size: latest.size };
  } catch {
    return null;
  }
}

/** Fallback: the newest release asset on GitHub. */
async function githubRelease() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const release = await response.json();
    const apk = (release.assets ?? []).find((asset) => asset.name.endsWith('.apk'));
    return apk ? { url: apk.browser_download_url, tag: release.tag_name, size: apk.size } : null;
  } catch {
    return null;
  }
}

/** Show the place counts the app is downloading right now (poi/ on this site). */
async function showPlaceCounts() {
  try {
    const response = await fetch('poi/manifest.json', { cache: 'no-cache' });
    if (!response.ok) return;
    const manifest = await response.json();
    for (const element of document.querySelectorAll('[data-count]')) {
      const count = manifest.kinds?.[element.dataset.count]?.count;
      if (Number.isFinite(count)) element.textContent = count.toLocaleString('en-IN');
    }
  } catch {
    // Keep the counts written into the page.
  }
}

if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  for (const note of document.querySelectorAll('[data-ios-note]')) note.hidden = false;
}

showLatestRelease();
showPlaceCounts();
