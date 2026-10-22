interface DownloadProgressProps {
  regionName?: string;
  percent: number;
  statusMessage: string;
  visible?: boolean;
}

export function DownloadProgress({
  regionName,
  percent,
  statusMessage,
  visible = true,
}: DownloadProgressProps) {
  if (!visible) return null;

  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className="tc-download" role="status" aria-live="polite">
      <div className="tc-download-header">
        <strong>{regionName ?? 'Map package'}</strong>
        <span className="tc-download-pct">{Math.round(clamped)}%</span>
      </div>
      <div
        className="tc-download-track"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${regionName ?? 'Map package'} download`}
      >
        <div className="tc-download-fill" style={{ width: `${clamped}%` }} />
      </div>
      <p className="tc-download-msg">{statusMessage}</p>
    </div>
  );
}
