import { useMemo } from 'react';
import type { Coordinate } from '../routing/routing-adapter';

const THUMB_SIZE = 64;
const THUMB_PAD = 10;
/** Enough points for the shape; long routes have thousands. */
const THUMB_POINTS = 80;

/** A route's or ride's shape, north up, with its start, stops and end. */
export function TrackThumbnail({ coordinates, stops = [] }: { coordinates: Coordinate[]; stops?: Coordinate[] }) {
  const shape = useMemo(() => thumbnailShape(coordinates, stops), [coordinates, stops]);
  return (
    <svg className="tc-trip-thumb" viewBox={`0 0 ${THUMB_SIZE} ${THUMB_SIZE}`} aria-hidden>
      <polyline className="tc-trip-thumb-casing" points={shape.line} />
      <polyline className="tc-trip-thumb-line" points={shape.line} />
      {shape.stops.map(([x, y], i) => (
        <circle key={i} className="tc-trip-thumb-stop" cx={x} cy={y} r={2.6} />
      ))}
      <circle className="tc-trip-thumb-end" cx={shape.end[0]} cy={shape.end[1]} r={3.8} />
      {/* On top, so a loop shows its start inside the end ring. */}
      <circle className="tc-trip-thumb-start" cx={shape.start[0]} cy={shape.start[1]} r={3} />
    </svg>
  );
}

function thumbnailShape(coords: Coordinate[], stops: Coordinate[]) {
  // Shrink longitude by latitude, so the shape keeps its proportions.
  const midLat = (coords[0]![1] + coords[coords.length - 1]![1]) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of coords) {
    minX = Math.min(minX, lon * kx);
    maxX = Math.max(maxX, lon * kx);
    minY = Math.min(minY, lat);
    maxY = Math.max(maxY, lat);
  }
  const scale = (THUMB_SIZE - 2 * THUMB_PAD) / Math.max(maxX - minX, maxY - minY, 1e-6);
  const offsetX = (THUMB_SIZE - (maxX - minX) * scale) / 2;
  const offsetY = (THUMB_SIZE - (maxY - minY) * scale) / 2;
  const project = ([lon, lat]: Coordinate): [number, number] => [
    Math.round((offsetX + (lon * kx - minX) * scale) * 10) / 10,
    Math.round((offsetY + (maxY - lat) * scale) * 10) / 10,
  ];
  const step = Math.max(1, Math.floor(coords.length / THUMB_POINTS));
  const line = coords
    .filter((_, i) => i % step === 0 || i === coords.length - 1)
    .map((point) => project(point).join(','))
    .join(' ');
  return {
    line,
    start: project(coords[0]!),
    end: project(coords[coords.length - 1]!),
    stops: stops.map(project),
  };
}
