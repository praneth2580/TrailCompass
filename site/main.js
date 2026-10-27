// Progressive enhancement for the landing page; it works without this file.
// Download links default to GitHub's latest-release page.
const REPO = 'praneth2580/TrailCompass';

/** Point every download button straight at the newest APK, with its version and size. */
async function showLatestRelease() {
  const metas = document.querySelectorAll('[data-release-meta]');
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const apk = (release.assets ?? []).find((asset) => asset.name.endsWith('.apk'));
    if (!apk) throw new Error('The latest release has no APK');

    for (const link of document.querySelectorAll('[data-download]')) {
      link.href = apk.browser_download_url;
    }
    const megabytes = (apk.size / 1_000_000).toFixed(1);
    for (const meta of metas) {
      meta.textContent = `${release.tag_name} · ${megabytes} MB · Android 6.0+`;
    }
    for (const version of document.querySelectorAll('[data-release-version]')) {
      version.textContent = release.tag_name;
    }
  } catch {
    // Rate-limited or offline: the links still open the release page.
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
