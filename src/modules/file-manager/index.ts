import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import open from 'open';
import { ExecutionResult } from '../../shared/types';
import logger from '../../shared/logger';
import { resolveUserPath } from '../../shared/path-utils';
import { config } from '../../config';

const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_ENTRIES = 50_000;
const MAX_SEARCH_TIME_MS = 15_000;
const SKIPPED_SEARCH_DIRECTORIES = new Set([
  '$recycle.bin',
  'appdata',
  'config.msi',
  'node_modules',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'system volume information',
  'windows',
  '.git',
  '.svn',
]);

/**
 * File Manager Module
 * Handles file/folder creation, reading, deletion, and opening in the OS.
 */
export class FileManager {
  private isWithinPath(targetPath: string, rootPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(rootPath);
    const relative = path.relative(root, resolved);
    return relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  private isProtectedPath(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const protectedPaths = process.platform === 'win32'
      ? [
          path.join(path.parse(resolved).root, 'Windows'),
          path.join(path.parse(resolved).root, 'Program Files'),
          path.join(path.parse(resolved).root, 'Program Files (x86)'),
          path.join(path.parse(resolved).root, 'ProgramData'),
          path.join(path.parse(resolved).root, '$Recycle.Bin'),
          path.join(path.parse(resolved).root, 'System Volume Information'),
        ]
      : ['/etc', '/boot', '/sys', '/proc', '/usr/bin', '/usr/sbin'];

    return protectedPaths.some((protectedPath) => this.isWithinPath(resolved, protectedPath));
  }

  /** Writes and deletes stay inside ALLOWED_PATHS; read/search may also use local drives. */
  private validatePath(targetPath: string, allowDriveRead = false): boolean {
    const resolved = path.resolve(targetPath);
    if (this.isProtectedPath(resolved)) return false;

    const allowedPaths = config.security.allowedPaths.length > 0
      ? config.security.allowedPaths
      : [os.homedir()];

    if (allowedPaths.some((allowed) => this.isWithinPath(resolved, allowed))) {
      return true;
    }

    return allowDriveRead &&
      process.platform === 'win32' &&
      /^[a-z]:\\?$/i.test(path.parse(resolved).root);
  }

  /** Resolve common path aliases like ~ to actual paths. */
  resolvePath(inputPath: string): string {
    return resolveUserPath(inputPath);
  }

  /** Search filenames (not file contents) in a folder or on local drives. */
  async findFiles(query: string, location?: string): Promise<ExecutionResult> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { success: false, message: 'Please provide a filename or part of a filename to search for.' };
    }

    const roots = location
      ? [this.resolveSearchLocation(location)]
      : this.getDefaultSearchRoots();
    if (roots.some((root) => !this.validatePath(root, true))) {
      return { success: false, message: 'Search location is not an allowed local path.' };
    }

    const results: Array<{ path: string; type: 'file' }> = [];
    const visited = new Set<string>();
    let entriesVisited = 0;
    let inaccessibleDirectories = 0;
    const deadline = Date.now() + MAX_SEARCH_TIME_MS;
    let stoppedEarly = false;

    for (const root of roots) {
      const stack = [root];
      while (stack.length > 0 && results.length < MAX_SEARCH_RESULTS) {
        if (entriesVisited >= MAX_SEARCH_ENTRIES || Date.now() >= deadline) {
          stoppedEarly = true;
          break;
        }

        const current = stack.pop()!;
        const visitKey = path.resolve(current).toLowerCase();
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        let entries: import('fs').Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          inaccessibleDirectories++;
          continue;
        }

        for (const entry of entries) {
          entriesVisited++;
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (!SKIPPED_SEARCH_DIRECTORIES.has(entry.name.toLowerCase())) {
              stack.push(entryPath);
            }
          } else if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
            results.push({ path: entryPath, type: 'file' });
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }

          if (entriesVisited >= MAX_SEARCH_ENTRIES || Date.now() >= deadline) {
            stoppedEarly = true;
            break;
          }
        }

        if (stoppedEarly) break;
      }
      if (stoppedEarly || results.length >= MAX_SEARCH_RESULTS) break;
    }

    const locationDescription = location || 'Desktop, Downloads, Documents, C: and D:';
    const details = [
      results.length
        ? `Found ${results.length} matching file(s) in ${locationDescription}:`
        : `No files matching "${query}" were found in ${locationDescription}.`,
      ...results.map((result) => `• ${result.path}`),
    ];
    if (stoppedEarly) details.push('Search stopped at its time or entry limit; results may be incomplete.');
    if (inaccessibleDirectories > 0) {
      details.push(`Skipped ${inaccessibleDirectories} folder(s) that Windows would not let the bot read.`);
    }

    logger.info(`File search for "${query}" checked ${entriesVisited} entries and found ${results.length} match(es).`);
    return { success: true, message: details.join('\n'), data: results };
  }

  private resolveSearchLocation(location: string): string {
    const trimmed = location.trim();
    const driveMatch = trimmed.match(/^([a-z]):?(?:\s+drive)?[\\/]?$/i);
    if (driveMatch) return `${driveMatch[1].toUpperCase()}:\\`;
    return this.resolvePath(trimmed.replace(/\s+drive$/i, ''));
  }

  private getDefaultSearchRoots(): string[] {
    if (process.platform !== 'win32') {
      return [
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Documents'),
        os.homedir(),
      ];
    }

    return [
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Documents'),
      os.homedir(),
      path.parse(os.homedir()).root,
      'D:\\',
    ];
  }

  /** Read a file's content. */
  async readFile(filePath: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(filePath);
    if (!this.validatePath(resolved, true)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    try {
      const content = await fs.readFile(resolved, 'utf-8');
      return { success: true, message: `File read successfully`, data: content };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      logger.error(`Failed to read file ${resolved}: ${msg}`);
      return { success: false, message: `Failed to read file: ${msg}` };
    }
  }

  /** Write content to a file, creating intermediate directories as needed. */
  async writeFile(filePath: string, content: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(filePath);
    if (!this.validatePath(resolved)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      logger.info(`File written: ${resolved}`);
      return { success: true, message: `File written to ${resolved}` };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      logger.error(`Failed to write file ${resolved}: ${msg}`);
      return { success: false, message: `Failed to write file: ${msg}` };
    }
  }

  /** Create a new directory. */
  async createDirectory(dirPath: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(dirPath);
    if (!this.validatePath(resolved)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    try {
      await fs.mkdir(resolved, { recursive: true });
      logger.info(`Directory created: ${resolved}`);
      return { success: true, message: `Directory created at ${resolved}` };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      return { success: false, message: `Failed to create directory: ${msg}` };
    }
  }

  /** List contents of a directory. */
  async listDirectory(dirPath: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(dirPath);
    if (!this.validatePath(resolved, true)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
      return { success: true, message: `Listed ${items.length} items in ${resolved}`, data: items };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      return { success: false, message: `Failed to list directory: ${msg}` };
    }
  }

  /** Delete a file. */
  async deleteFile(filePath: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(filePath);
    if (!this.validatePath(resolved)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    try {
      await fs.unlink(resolved);
      logger.info(`File deleted: ${resolved}`);
      return { success: true, message: `File deleted: ${resolved}` };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      return { success: false, message: `Failed to delete file: ${msg}` };
    }
  }

  /** Open a file or folder in the OS default handler. */
  async openInOS(targetPath: string): Promise<ExecutionResult> {
    const resolved = this.resolvePath(targetPath);
    if (!this.validatePath(resolved, true)) {
      return { success: false, message: `Access denied: path "${resolved}" is outside allowed directories` };
    }

    if (!fsSync.existsSync(resolved)) {
      return { success: false, message: `Path does not exist: ${resolved}` };
    }

    try {
      await open(resolved);
      logger.info(`Opened in OS: ${resolved}`);
      return { success: true, message: `Opened ${resolved}` };
    } catch (error: unknown) {
      const msg = (error as Error).message;
      return { success: false, message: `Failed to open path: ${msg}` };
    }
  }

  /** Check if a path exists. */
  async exists(targetPath: string): Promise<boolean> {
    try {
      const resolved = this.resolvePath(targetPath);
      if (!this.validatePath(resolved, true)) return false;
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }
}

export default new FileManager();
