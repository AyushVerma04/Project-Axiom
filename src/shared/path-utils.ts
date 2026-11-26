import os from 'os';
import path from 'path';

const NAMED_FOLDERS: Record<string, string> = {
  downloads: path.join(os.homedir(), 'Downloads'),
  download: path.join(os.homedir(), 'Downloads'),
  documents: path.join(os.homedir(), 'Documents'),
  document: path.join(os.homedir(), 'Documents'),
  docs: path.join(os.homedir(), 'Documents'),
  desktop: path.join(os.homedir(), 'Desktop'),
  pictures: path.join(os.homedir(), 'Pictures'),
  photos: path.join(os.homedir(), 'Pictures'),
  images: path.join(os.homedir(), 'Pictures'),
  music: path.join(os.homedir(), 'Music'),
  videos: path.join(os.homedir(), 'Videos'),
  video: path.join(os.homedir(), 'Videos'),
  movies: path.join(os.homedir(), 'Videos'),
  home: os.homedir(),
};

/** Resolve home and named-folder paths, including paths beneath those folders. */
export function resolveUserPath(inputPath: string): string {
  const cleaned = inputPath.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (/^~([\\/]|$)/.test(cleaned)) {
    return path.resolve(os.homedir(), cleaned.slice(1).replace(/^[\\/]+/, ''));
  }

  const aliasMatch = cleaned.replace(/^[\\/]+/, '').match(
    /^(downloads?|documents?|docs|desktop|pictures|photos|images|music|videos?|movies|home)(?:\s+(?:folder|directory))?(?:[\\/](.*))?$/i
  );
  if (aliasMatch) {
    const alias = aliasMatch[1].toLowerCase().replace(/\s+(?:folder|directory)$/i, '');
    const folder = NAMED_FOLDERS[alias];
    if (folder) return path.resolve(folder, aliasMatch[2] || '');
  }

  if (process.platform === 'win32' && /^[a-z]:$/i.test(cleaned)) {
    return `${cleaned.toUpperCase()}\\`;
  }

  return path.resolve(cleaned);
}
