import open, { apps } from 'open';
import { ExecutionResult } from '../../shared/types';
import logger from '../../shared/logger';

/**
 * Browser Controller Module
 * Opens URLs and performs web searches using the system browser.
 */
export class BrowserController {
  /** Validate that a string is a safe URL. */
  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  /** Open a URL in the user's browser. */
  async openUrl(url: string, browser?: string): Promise<ExecutionResult> {
    let fullUrl = url.trim();
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = `https://${fullUrl}`;
    }

    if (!this.isValidUrl(fullUrl)) {
      return { success: false, message: `Invalid URL: ${url}` };
    }

    try {
      logger.info(`Opening URL: ${fullUrl} (browser: ${browser || 'default'})`);
      const b = (browser || '').toLowerCase().trim();

      if (b === 'chrome' || b === 'google chrome') {
        await open(fullUrl, { app: { name: apps.chrome } }).catch(() => open(fullUrl));
      } else if (b === 'edge' || b === 'microsoft edge') {
        await open(fullUrl, { app: { name: apps.edge } }).catch(() => open(fullUrl));
      } else if (b === 'firefox' || b === 'mozilla firefox') {
        await open(fullUrl, { app: { name: apps.firefox } }).catch(() => open(fullUrl));
      } else if (b === 'brave') {
        await open(fullUrl, { app: { name: apps.brave } }).catch(() => open(fullUrl));
      } else {
        await open(fullUrl);
      }

      return { success: true, message: `Opened ${fullUrl} in ${browser || 'default browser'}` };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      logger.error(`Failed to open URL: ${msg}`);
      return { success: false, message: `Failed to open URL: ${msg}` };
    }
  }

  /** Perform a web search using Google. */
  async search(query: string, browser?: string): Promise<ExecutionResult> {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return this.openUrl(searchUrl, browser);
  }

  /** Open a well-known website by name. */
  resolveWebsite(name: string): string | null {
    const sites: Record<string, string> = {
      github: 'https://github.com',
      leetcode: 'https://leetcode.com',
      stackoverflow: 'https://stackoverflow.com',
      youtube: 'https://youtube.com',
      google: 'https://google.com',
      twitter: 'https://twitter.com',
      reddit: 'https://reddit.com',
      linkedin: 'https://linkedin.com',
      npm: 'https://npmjs.com',
      docker: 'https://hub.docker.com',
      chatgpt: 'https://chat.openai.com',
      claude: 'https://claude.ai',
    };

    const lower = name.toLowerCase().trim();
    return sites[lower] || null;
  }
}

export default new BrowserController();
