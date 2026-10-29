import { Share } from '@capacitor/share';
import type { ShareableFile } from '../offline/pack-files';

/** What the share sheet shows with a file. */
export interface ShareText {
  title: string;
  text: string;
  dialogTitle: string;
}

/**
 * Hands a file to Android's share sheet, or downloads it in a browser.
 * Resolves false when the rider dismisses the sheet.
 */
export async function shareFile(file: ShareableFile, fileName: string, info: ShareText): Promise<boolean> {
  if ('blob' in file) {
    downloadBlob(fileName, file.blob);
    return true;
  }
  try {
    await Share.share({ ...info, files: [file.uri] });
    return true;
  } catch (e) {
    if (isShareCancelled(e)) return false;
  }

  // Fallback for platforms that only accept url.
  try {
    await Share.share({ ...info, url: file.uri });
    return true;
  } catch (e) {
    if (isShareCancelled(e)) return false;
    throw e;
  }
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The Share plugin rejects with "Share canceled" when the sheet is dismissed. */
function isShareCancelled(e: unknown): boolean {
  return e instanceof Error && /cancel/i.test(e.message);
}
