import { Preferences } from '@capacitor/preferences';

/**
 * Lightweight JSON key-value store (Preferences / localStorage).
 * SQLite can replace this later without changing repository call sites much.
 */
export class JsonDatabase {
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  private key(id: string): string {
    return `${this.namespace}:${id}`;
  }

  async getJson<T>(id: string): Promise<T | null> {
    const { value } = await Preferences.get({ key: this.key(id) });
    if (value == null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async setJson<T>(id: string, data: T): Promise<void> {
    await Preferences.set({
      key: this.key(id),
      value: JSON.stringify(data),
    });
  }

  async remove(id: string): Promise<void> {
    await Preferences.remove({ key: this.key(id) });
  }

  async listKeys(): Promise<string[]> {
    const { keys } = await Preferences.keys();
    const prefix = `${this.namespace}:`;
    return keys
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
}

export const appDatabase = new JsonDatabase('trailcompass');
