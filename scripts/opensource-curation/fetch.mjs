import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { curationDataDir, loadConfig, logsDir, reposJson } from './paths.mjs';

const GITHUB_API = 'https://api.github.com';
const README_MAX_CHARS = 40_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(message);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, 'fetch.log'), line).catch(() => {});
}

function githubHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dev-blog-opensource-curation/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchRepoMeta(owner, name) {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${name}`, { headers: githubHeaders() });
    if (!res.ok) return {};
    const data = await res.json();
    return {
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      language: data.language || '',
      topics: data.topics || [],
      license: data.license?.spdx_id || '',
      open_issues: data.open_issues_count ?? 0,
      watchers: data.watchers_count ?? 0,
      description: data.description || '',
      homepage: data.homepage || '',
      archived: data.archived === true,
    };
  } catch (e) {
    await logLine(`warning: metadata ${owner}/${name}: ${e.message}`);
    return {};
  }
}

async function fetchReadme(owner, name) {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${name}/readme`, { headers: githubHeaders() });
    if (!res.ok) return '';
    const data = await res.json();
    const content = data.content || '';
    const encoding = data.encoding || 'base64';
    let text =
      encoding === 'base64'
        ? Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8')
        : content;
    if (text.length > README_MAX_CHARS) {
      await logLine(`info: README truncated ${text.length} → ${README_MAX_CHARS} (${owner}/${name})`);
      text = text.slice(0, README_MAX_CHARS);
    }
    return text;
  } catch (e) {
    await logLine(`warning: README ${owner}/${name}: ${e.message}`);
    return '';
  }
}

async function main() {
  await loadConfig();
  await mkdir(curationDataDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  let repos;
  try {
    repos = JSON.parse(await readFile(reposJson, 'utf8'));
  } catch {
    await logLine(`error: ${reposJson} not found — run opensource-curation:discover first`);
    process.exit(1);
  }
  if (!Array.isArray(repos) || !repos.length) {
    await logLine('error: repos.json empty');
    process.exit(1);
  }

  let success = 0;
  for (const repo of repos) {
    const { owner, name, full_name: fullName } = repo;
    await logLine(`Fetching ${fullName} ...`);
    const meta = await fetchRepoMeta(owner, name);
    Object.assign(repo, meta);
    await sleep(1000);
    const readme = await fetchReadme(owner, name);
    repo.readme = readme;
    await sleep(1000);
    if (readme) {
      success += 1;
      await logLine(`  README ${readme.length} chars, stars: ${repo.stars ?? 0}`);
    } else {
      await logLine(`warning: no README for ${fullName}`);
    }
  }

  await writeFile(reposJson, JSON.stringify(repos, null, 2));
  await logLine(`Fetched README for ${success}/${repos.length} → ${path.relative(process.cwd(), reposJson)}`);
  if (success === 0) {
    await logLine('error: no READMEs fetched');
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, 'fetch.log'), `${new Date().toISOString()} FATAL ${err.stack || err.message}\n`).catch(() => {});
  process.exit(1);
});
