import type { GovmapApi } from './types';

const JQUERY_URL = 'https://code.jquery.com/jquery-1.12.4.min.js';

/**
 * Loads the govmap API script once per page (it depends on jQuery) and resolves
 * with the `window.govmap` global. Concurrent callers share one load.
 */
export class GovmapLoader {
  private static pending: Promise<GovmapApi> | null = null;

  static load(scriptUrl: string, timeoutMs = 20_000): Promise<GovmapApi> {
    if (window.govmap) return Promise.resolve(window.govmap);
    this.pending ??= (async () => {
      if (!window.jQuery) await this.injectScript(JQUERY_URL, timeoutMs);
      await this.injectScript(scriptUrl, timeoutMs);
      const api = await this.waitFor(() => window.govmap, timeoutMs);
      return api;
    })().catch((err: unknown) => {
      this.pending = null;
      throw err;
    });
    return this.pending;
  }

  /** Installs an API implementation directly (mock mode / tests). */
  static install(api: GovmapApi): GovmapApi {
    window.govmap = api;
    return api;
  }

  private static injectScript(src: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${CSS.escape(src)}"]`);
      if (existing?.dataset.loaded === 'true') return resolve();
      const script = existing ?? document.createElement('script');
      const timer = setTimeout(() => reject(new Error(`Timed out loading ${src}`)), timeoutMs);
      script.addEventListener('load', () => {
        clearTimeout(timer);
        script.dataset.loaded = 'true';
        resolve();
      });
      script.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Failed to load ${src} (blocked or offline?)`));
      });
      if (!existing) {
        script.src = src;
        script.async = true;
        document.body.appendChild(script);
      }
    });
  }

  private static waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        const value = get();
        if (value) return resolve(value);
        if (Date.now() - start > timeoutMs) return reject(new Error('govmap API did not initialise'));
        setTimeout(poll, 50);
      };
      poll();
    });
  }
}
