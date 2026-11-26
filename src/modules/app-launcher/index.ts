import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppRegistryEntry, ExecutionResult } from '../../shared/types';
import logger from '../../shared/logger';
import { resolveUserPath } from '../../shared/path-utils';

/**
 * Application Launcher Module
 * Launches GUI apps, browsers and editors with the native mechanism of each OS:
 *   Windows -> PowerShell Start-Process  (App Paths, PATH, URI protocols, .cmd shims)
 *   macOS   -> `open -a`
 *   Linux   -> direct spawn (with fallbacks) / xdg-open
 * No third-party dependency, and failures are reported instead of swallowed.
 */

type BrowserKind = 'chrome' | 'firefox' | 'edge' | 'safari';

/** One concrete way of starting something. Attempts are tried in order until one works. */
interface Attempt {
  command: string;
  args: string[];
}

const BROWSERS = new Map<string, BrowserKind>([
  ['chrome', 'chrome'],
  ['google chrome', 'chrome'],
  ['google-chrome', 'chrome'],
  ['firefox', 'firefox'],
  ['mozilla firefox', 'firefox'],
  ['edge', 'edge'],
  ['msedge', 'edge'],
  ['microsoft edge', 'edge'],
  ['microsoft-edge', 'edge'],
  ['safari', 'safari'],
]);

const EDITORS = new Set(['code', 'visual studio code', 'cursor', 'windsurf']);
const FILE_MANAGERS = new Set(['explorer', 'file explorer', 'finder', 'nautilus']);
/** Shells / terminals: arguments from chat are ignored so they can never become commands. */
const SHELLS = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'wt',
  'bash', 'sh', 'zsh', 'terminal', 'gnome-terminal',
]);

/** Linux: alternative executables to try if the first one is not installed. */
const LINUX_FALLBACKS = new Map<string, string[]>([
  ['chrome', ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']],
  ['edge', ['microsoft-edge', 'microsoft-edge-stable']],
  ['gnome-terminal', ['x-terminal-emulator', 'konsole', 'xfce4-terminal']],
  ['nautilus', ['dolphin', 'thunar', 'xdg-open']],
]);

/** `spotify:`, `discord:`, `tg://` ... */
const PROTOCOL = /^[a-z][a-z0-9+.-]+:(\/\/)?$/i;
/** Unregistered app names must look like a plain name, never a path or a shell expression. */
const SAFE_APP_NAME = /^\w[\w .+-]{0,63}$/;
/** How long we wait to see whether a launch fails right away before calling it a success. */
const GRACE_MS = process.platform === 'win32' ? 8000 : 1500;

const entry = (name: string, command: string, ...aliases: string[]): AppRegistryEntry => ({
  name,
  aliases,
  command,
});

/** Windows: well-known install locations, used when the app is not registered in PATH / App Paths. */
function windowsFallbackPaths(id: string): string[] {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const table = new Map<string, string[]>([
    ['chrome', [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    ]],
    ['edge', [
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]],
    ['firefox', [`${pf}\\Mozilla Firefox\\firefox.exe`, `${pf86}\\Mozilla Firefox\\firefox.exe`]],
    ['code', [`${local}\\Programs\\Microsoft VS Code\\Code.exe`, `${pf}\\Microsoft VS Code\\Code.exe`]],
    ['cursor', [`${local}\\Programs\\cursor\\Cursor.exe`]],
    ['windsurf', [`${local}\\Programs\\Windsurf\\Windsurf.exe`]],
  ]);
  return (table.get(id) ?? []).filter((p) => fs.existsSync(p));
}

export class AppLauncher {
  private registry: AppRegistryEntry[];
  private platform: NodeJS.Platform;

  /** Set to false to allow only apps from the registry (recommended if the bot is reachable by others). */
  allowUnregistered = true;

  constructor() {
    this.platform = os.platform();
    this.registry = this.getDefaultRegistry();
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  /** Returns the default app registry for the current OS. */
  private getDefaultRegistry(): AppRegistryEntry[] {
    if (this.platform === 'win32') {
      return [
        entry('Visual Studio Code', 'code', 'vscode', 'vs code', 'code'),
        entry('Cursor', 'cursor', 'cursor', 'cursor editor', 'cursor ai'),
        entry('Windsurf', 'windsurf', 'windsurf', 'windsurf editor'),
        entry('Google Chrome', 'chrome', 'chrome', 'google chrome'),
        entry('Mozilla Firefox', 'firefox', 'firefox'),
        entry('Microsoft Edge', 'msedge', 'edge', 'microsoft edge'), // exe is msedge, not "edge"
        entry('Notepad', 'notepad', 'notepad'),
        entry('File Explorer', 'explorer', 'explorer', 'file explorer', 'files'),
        entry('Command Prompt', 'cmd', 'cmd', 'command prompt'),
        entry('PowerShell', 'powershell', 'powershell', 'terminal'),
        entry('Windows Terminal', 'wt', 'windows terminal', 'wt'),
        entry('Task Manager', 'taskmgr', 'task manager', 'taskmgr'),
        entry('Calculator', 'calc', 'calculator', 'calc'),
        entry('Spotify', 'spotify:', 'spotify'),
        entry('Discord', 'discord:', 'discord'),
        entry('Slack', 'slack:', 'slack'),
        entry('WhatsApp', 'whatsapp:', 'whatsapp', 'whats app'),
        entry('Telegram', 'tg://', 'telegram'), // Telegram Desktop registers tg://, not telegram:
        entry('Microsoft Word', 'winword', 'word', 'microsoft word', 'ms word'),
        entry('Microsoft Excel', 'excel', 'excel', 'microsoft excel', 'ms excel'),
        entry('Microsoft PowerPoint', 'powerpnt', 'powerpoint', 'ppt'),
        entry('Paint', 'mspaint', 'paint', 'mspaint'),
        entry('Snipping Tool', 'snippingtool', 'snipping tool', 'screenshot'),
      ];
    }

    if (this.platform === 'darwin') {
      return [
        entry('Visual Studio Code', 'Visual Studio Code', 'vscode', 'vs code', 'code'),
        entry('Cursor', 'Cursor', 'cursor'),
        entry('Windsurf', 'Windsurf', 'windsurf'),
        entry('Google Chrome', 'Google Chrome', 'chrome', 'google chrome'),
        entry('Microsoft Edge', 'Microsoft Edge', 'edge', 'microsoft edge'),
        entry('Safari', 'Safari', 'safari'),
        entry('Firefox', 'Firefox', 'firefox'),
        entry('Terminal', 'Terminal', 'terminal'),
        entry('Finder', 'Finder', 'finder', 'files'),
        entry('Calculator', 'Calculator', 'calculator', 'calc'),
        entry('Spotify', 'Spotify', 'spotify'),
        entry('Discord', 'Discord', 'discord'),
        entry('Slack', 'Slack', 'slack'),
        entry('Telegram', 'Telegram', 'telegram'),
      ];
    }

    // Linux
    return [
      entry('Visual Studio Code', 'code', 'vscode', 'vs code', 'code'),
      entry('Google Chrome', 'google-chrome', 'chrome', 'google chrome'),
      entry('Microsoft Edge', 'microsoft-edge', 'edge', 'microsoft edge'),
      entry('Firefox', 'firefox', 'firefox'),
      entry('Terminal', 'gnome-terminal', 'terminal'),
      entry('Files', 'nautilus', 'files', 'nautilus'),
      entry('Calculator', 'gnome-calculator', 'calculator', 'calc'),
      entry('Spotify', 'spotify', 'spotify'),
      entry('Discord', 'discord', 'discord'),
      entry('Slack', 'slack', 'slack'),
      entry('Telegram', 'telegram-desktop', 'telegram'),
    ];
  }

  /** Add a custom app to the registry. */
  registerApp(entry: AppRegistryEntry): void {
    this.registry.push(entry);
    logger.info(`Registered app: ${entry.name}`);
  }

  /** Find an app in the registry by name or alias. */
  findApp(query: string): AppRegistryEntry | undefined {
    const q = query.toLowerCase().trim();
    return this.registry.find(
      (app) =>
        app.name.toLowerCase() === q ||
        app.aliases.some((alias) => alias.toLowerCase() === q)
    );
  }

  /** List all registered applications. */
  listApps(): string[] {
    return this.registry.map((app) => app.name);
  }

  // ---------------------------------------------------------------------------
  // Public launch API
  // ---------------------------------------------------------------------------

  /** Launch an application by name. `args` is a URL for browsers, a path for editors / file managers. */
  async launch(appName: string, args?: string): Promise<ExecutionResult> {
    const query = appName.trim();
    const app = this.findApp(query);

    if (!app && (!this.allowUnregistered || !SAFE_APP_NAME.test(query))) {
      return { success: false, message: `Unknown app: "${query}"` };
    }

    const name = app?.name ?? query;
    const command = app?.command ?? query;
    const key = command.toLowerCase();
    const browser = BROWSERS.get(key);

    logger.info(`Launching: ${name} (${command})`);

    let argv: string[];
    try {
      argv = this.buildArgs(key, browser, args);
    } catch (error: unknown) {
      return this.failure(name, error);
    }

    try {
      await this.tryAttempts(this.buildAttempts(command, argv, browser));
      return this.success(`Successfully launched ${name}`);
    } catch (error: unknown) {
      // A browser that is missing should not make "open this link" fail – but say what happened.
      if (browser) {
        try {
          await this.tryAttempts(this.defaultBrowserAttempts(argv[0]));
          return this.success(
            `${name} could not be started, so the link was opened in your default browser instead.`
          );
        } catch {
          /* fall through to the failure result below */
        }
      }
      return this.failure(name, error);
    }
  }

  /**
   * Open a folder or file in a code editor (VS Code, Cursor, Windsurf).
   * Falls back to the file manager if no editor can be started.
   */
  async openInEditor(targetPath: string, editor = 'vscode'): Promise<ExecutionResult> {
    const key = editor.toLowerCase().replace(/[\s_-]/g, '');
    const candidates = key.includes('cursor')
      ? ['cursor', 'code']
      : key.includes('windsurf')
        ? ['windsurf', 'code']
        : ['code'];

    for (const candidate of candidates) {
      logger.info(`Opening "${targetPath}" in ${candidate}`);
      const result = await this.launch(candidate, targetPath);
      if (result.success) {
        return { success: true, message: `Opened in ${candidate}: \`${targetPath}\`` };
      }
    }

    // Ultimate fallback: show the folder so the user can open it manually.
    let folder = targetPath;
    try {
      const resolved = this.resolvePath(targetPath);
      folder = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
    } catch {
      /* missing or invalid path – launch() will report it */
    }
    const fallback = await this.launch('files', folder);
    return {
      success: false,
      message:
        `Could not find ${candidates.join(' or ')}.` +
        (fallback.success ? ' Opened the folder in your file manager instead.' : '') +
        `\nMake sure your editor's CLI is in PATH (e.g. \`code\` for VS Code).`,
    };
  }

  // ---------------------------------------------------------------------------
  // Arguments
  // ---------------------------------------------------------------------------

  /** Turn the raw chat argument into a safe argv for this kind of app. Throws on bad input. */
  private buildArgs(key: string, browser: BrowserKind | undefined, raw?: string): string[] {
    const arg = raw?.trim();

    if (PROTOCOL.test(key) || SHELLS.has(key)) return [];

    if (browser) return [this.normalizeUrl(arg || 'https://www.google.com')];

    if (FILE_MANAGERS.has(key)) {
      const dir = this.resolvePath(arg || os.homedir());
      if (!fs.existsSync(dir)) throw new Error(`Path not found: ${dir}`);
      return [dir];
    }

    if (EDITORS.has(key)) {
      if (arg) return [this.resolvePath(arg)];
      return this.platform === 'darwin' ? [] : ['-n']; // -n = guarantee a visible new window
    }

    return arg ? [this.checkArg(arg)] : [];
  }

  /** Reject anything that could break out of quoting or be read as a command-line option. */
  private checkArg(arg: string): string {
    // eslint-disable-next-line no-control-regex
    if (arg.length > 1000 || /[\x00-\x1f"]/.test(arg) || arg.startsWith('-')) {
      throw new Error('Argument contains characters that are not allowed');
    }
    return arg;
  }

  private resolvePath(p: string): string {
    return resolveUserPath(this.checkArg(p));
  }

  /** "youtube.com" -> https://youtube.com, "cute cats" -> Google search, non-http(s) schemes are refused. */
  private normalizeUrl(input: string): string {
    const raw = input.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const looksLikeHost = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]\S*)?$/i.test(raw);

    let candidate: string;
    if (hasScheme) candidate = raw;
    else if (looksLikeHost) candidate = `${/^localhost/i.test(raw) ? 'http' : 'https'}://${raw}`;
    else candidate = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;

    const url = new URL(candidate); // throws on garbage
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only http(s) links can be opened in a browser');
    }
    return url.href; // normalised and percent-encoded (no raw quotes)
  }

  // ---------------------------------------------------------------------------
  // Launch plumbing
  // ---------------------------------------------------------------------------

  /** Environment for child processes: no Electron / VS Code IPC leftovers, and a display on Linux. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) continue;
      env[key] = value;
    }
    if (this.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) env.DISPLAY = ':0';
    return env;
  }

  /** The ordered list of ways to start `command` on this OS. */
  private buildAttempts(command: string, argv: string[], browser?: BrowserKind): Attempt[] {
    const key = command.toLowerCase();

    if (this.platform === 'win32') {
      const targets = [command, ...windowsFallbackPaths(browser ?? key)];
      return [...new Set(targets)].map((target) => this.powershellAttempt(target, argv));
    }

    if (this.platform === 'darwin') {
      return PROTOCOL.test(command)
        ? [{ command: 'open', args: [command] }]
        : [{ command: 'open', args: ['-a', command, ...argv] }];
    }

    if (PROTOCOL.test(command)) return [{ command: 'xdg-open', args: [command] }];
    const names = [command, ...(LINUX_FALLBACKS.get(browser ?? key) ?? [])];
    return [...new Set(names)].map((name) => ({ command: name, args: argv }));
  }

  private defaultBrowserAttempts(url: string): Attempt[] {
    if (this.platform === 'win32') return [this.powershellAttempt(url, [])];
    if (this.platform === 'darwin') return [{ command: 'open', args: [url] }];
    return [{ command: 'xdg-open', args: [url] }];
  }

  /**
   * Windows: Start-Process via -EncodedCommand. Everything is passed as single-quoted PowerShell
   * literals (only ' needs escaping), so there is no cmd.exe parsing, no %VAR% expansion and no injection.
   * -ErrorAction Stop + `exit 1` makes "app not found" show up as a non-zero exit code.
   */
  private powershellAttempt(target: string, argv: string[]): Attempt {
    const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const winArg = (a: string) =>
      /^[\w\-./:\\@]+$/.test(a) ? a : `"${a.replace(/\\+$/, (m) => m + m)}"`;

    const argList = argv.length ? ` -ArgumentList ${argv.map((a) => lit(winArg(a))).join(',')}` : '';
    const script =
      `$ErrorActionPreference='Stop'; ` +
      `try { Start-Process -FilePath ${lit(target)}${argList} } catch { exit 1 }`;

    return {
      command: path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
      ),
      args: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ],
    };
  }

  private async tryAttempts(attempts: Attempt[]): Promise<void> {
    let firstError: unknown;
    for (const attempt of attempts) {
      try {
        await this.run(attempt.command, attempt.args);
        return;
      } catch (error: unknown) {
        firstError ??= error; // report the app that was actually asked for, not the last fallback
      }
    }
    throw firstError ?? new Error('Nothing to try');
  }

  /**
   * Spawn a launcher process, detached from the bot.
   *  - spawn error (e.g. ENOENT)          -> rejects
   *  - exits quickly with code 0          -> resolves (launcher handed off to the app)
   *  - exits quickly with a non-zero code -> rejects
   *  - still running after GRACE_MS       -> resolves (the app itself is running)
   */
  private run(command: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      const child = spawn(command, args, {
        env: this.childEnv(),
        stdio: 'ignore',
        detached: this.platform !== 'win32',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        child.unref();
        finish();
      }, GRACE_MS);

      child.on('error', (error) => finish(error));
      child.on('exit', (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(signal ? `killed by ${signal}` : `exited with code ${code} (app not found?)`));
      });
    });
  }

  private success(message: string): ExecutionResult {
    logger.info(message);
    return { success: true, message };
  }

  private failure(name: string, error: unknown): ExecutionResult {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to launch ${name}: ${reason}`);
    return { success: false, message: `Failed to launch ${name}: ${reason}` };
  }
}

export default new AppLauncher();