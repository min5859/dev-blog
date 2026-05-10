import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

export const curationDataDir = path.join(root, 'data', 'opensource-curation');
export const reposJson = path.join(curationDataDir, 'repos.json');
export const historyJson = path.join(curationDataDir, 'history.json');
export const analysisDir = path.join(curationDataDir, 'analysis');
export const wikiCloneDir = path.join(curationDataDir, 'wiki_clone');
export const logsDir = path.join(root, 'logs', 'opensource-curation');
export const configPath = path.join(root, 'content', 'topics', 'opensource-curation', 'opensource-curation.config.json');

export async function loadConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export { root };
