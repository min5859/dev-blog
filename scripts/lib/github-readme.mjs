// Fetches a short README excerpt from GitHub for grounding rewrite prompts.
// We intentionally request only the first ~6 KiB and trim to text so that an
// unauthenticated nightly run stays well below GitHub's 60 req/h limit and
// never balloons prompt size. A failure is treated as "no excerpt".

const RAW_BYTES = 6 * 1024;
const EXCERPT_CHARS = 700;

function isGithubRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:[/#?]|$)/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, '') };
}

function stripMarkdown(text) {
  return text
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRawReadme(owner, repo, ref) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/README.md`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'dev-blog-readme-fetcher' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return text.slice(0, RAW_BYTES);
    }
    let received = 0;
    const decoder = new TextDecoder();
    let text = '';
    while (received < RAW_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received >= RAW_BYTES) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchReadmeExcerpt(repoUrl) {
  const parsed = isGithubRepoUrl(repoUrl);
  if (!parsed) return null;
  for (const ref of ['HEAD', 'main', 'master']) {
    const raw = await fetchRawReadme(parsed.owner, parsed.repo, ref);
    if (raw) {
      const trimmed = stripMarkdown(raw).slice(0, EXCERPT_CHARS);
      if (trimmed.length >= 40) return trimmed;
    }
  }
  return null;
}

// Adds a `readmeExcerpt` field to each candidateBody when a README is reachable.
// Bounded concurrency keeps the request burst small; partial failure is OK.
export async function enrichCandidatesWithReadme(candidateBodies, { concurrency = 3, limit = 10 } = {}) {
  if (!Array.isArray(candidateBodies) || !candidateBodies.length) return candidateBodies;
  const targets = candidateBodies.slice(0, limit);
  let index = 0;
  async function worker() {
    while (index < targets.length) {
      const current = targets[index];
      index += 1;
      try {
        const excerpt = await fetchReadmeExcerpt(current.url);
        if (excerpt) current.readmeExcerpt = excerpt;
      } catch {
        // ignore — README excerpt is best-effort grounding
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, () => worker());
  await Promise.all(workers);
  return candidateBodies;
}
