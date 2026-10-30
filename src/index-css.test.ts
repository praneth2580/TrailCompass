import mapLibreCss from 'maplibre-gl/dist/maplibre-gl.css?raw';
import { describe, expect, it } from 'vitest';
import appCss from './index.css?raw';

/** Every MapLibre selector a stylesheet has, spaced the same way. */
function mapLibreSelectors(css: string): Set<string> {
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{/g);
  return new Set(
    [...selectors]
      .flatMap((match) => match[1]!.split(','))
      .map((selector) => selector.replace(/\s*([+>])\s*/g, '$1').replace(/\s+/g, ' ').trim())
      .filter((selector) => selector.includes('maplibregl')),
  );
}

describe('index.css', () => {
  // MapLibre's stylesheet comes after ours in the build. With the same selector
  // the minifier deletes our rule, even !important, and only production shows it:
  // the zoom buttons ended up in the corner of the screen that way. Scope overrides
  // under .tc-map-container instead.
  it('never styles MapLibre with one of its own selectors', () => {
    const ours = mapLibreSelectors(appCss);
    expect(ours.size).toBeGreaterThan(0);
    const shared = [...mapLibreSelectors(mapLibreCss)].filter((selector) => ours.has(selector));
    expect(shared).toEqual([]);
  });
});
