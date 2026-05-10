import { appendFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAiAdapterPrompt } from '../lib/ai-rewrite-adapter.mjs';
import { analysisDir, curationDataDir, loadConfig, logsDir, reposJson, root } from './paths.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(message);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, 'analyze.log'), line).catch(() => {});
}

function stripBkitFooter(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^─.*bkit Feature Usage/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function hasKorean(text) {
  const m = text.match(/[가-힣]/g);
  return Boolean(m && m.length >= 10);
}

async function fileNonEmpty(filePath) {
  try {
    const s = await stat(filePath);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const config = await loadConfig();
  const maxRetries = Number(config.analysis?.maxRetries ?? 2);
  const maxAttempts = maxRetries + 1;
  const promptRel = config.analysis?.promptFile || 'prompts/opensource-curation-analyze-ko.md';
  const promptPath = path.join(root, promptRel);
  const defaultAdapter = process.env.OPENSOURCE_CURATION_ANALYZE_ADAPTER?.trim() || config.analysis?.adapter || 'cursor';

  await mkdir(curationDataDir, { recursive: true });
  await mkdir(analysisDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  let repos;
  try {
    repos = JSON.parse(await readFile(reposJson, 'utf8'));
  } catch {
    await logLine(`error: ${reposJson} not found`);
    process.exit(1);
  }
  if (!Array.isArray(repos) || !repos.length) {
    await logLine('error: repos.json empty');
    process.exit(1);
  }

  const promptTemplate = await readFile(promptPath, 'utf8');
  let successCount = 0;

  for (const repo of repos) {
    const { owner, name, full_name: fullName } = repo;
    const safeName = `${owner}_${name}`;
    const outputFile = path.join(analysisDir, `${safeName}.md`);

    if (await fileNonEmpty(outputFile)) {
      await logLine(`skip (exists): ${outputFile}`);
      successCount += 1;
      continue;
    }

    const readme = repo.readme || '';
    if (!readme) {
      await logLine(`error: no README for ${fullName}, skipping`);
      continue;
    }

    await logLine(`Analyzing ${fullName} (${repo.stars ?? 0} stars) ...`);

    const fullPrompt = `${promptTemplate}

---

## 레포지토리 정보
- **이름**: ${fullName}
- **URL**: https://github.com/${fullName}
- **설명**: ${repo.description || ''}
- **Stars**: ${repo.stars ?? 0}
- **언어**: ${repo.language || ''}
- **토픽**: ${(repo.topics || []).join(', ')}
- **라이선스**: ${repo.license || ''}

## README

${readme}`;

    let ok = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await logLine(`retry ${attempt}/${maxRetries} for ${fullName} (Korean check)`);
      if (attempt > 0) await sleep(3000);

      const text = await runAiAdapterPrompt(fullPrompt, { defaultAdapter });
      if (!text || !text.trim()) {
        await logLine(`attempt ${attempt + 1}: empty output for ${fullName}`);
        continue;
      }
      let body = stripBkitFooter(text.trim());
      if (!hasKorean(body)) {
        await logLine(`attempt ${attempt + 1}: output not Korean enough for ${fullName}`);
        continue;
      }
      await writeFile(outputFile, `${body}\n`, 'utf8');
      ok = true;
      await logLine(`saved ${outputFile} (${body.length} chars)`);
      break;
    }

    if (ok) successCount += 1;
    else {
      await logLine(`error: exhausted retries for ${fullName}`);
      try {
        await unlink(outputFile);
      } catch {
        /* empty */
      }
    }

    await sleep(2000);
  }

  await logLine(`Analysis complete (${successCount}/${repos.length} repos with usable analysis)`);
  if (successCount === 0) {
    await logLine('error: no successful analyses');
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, 'analyze.log'), `${new Date().toISOString()} FATAL ${err.stack || err.message}\n`).catch(() => {});
  process.exit(1);
});
