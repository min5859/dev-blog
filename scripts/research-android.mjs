import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runResearch } from './lib/research-runner.mjs';

const root = process.cwd();
const topic = 'android';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const generatedDir = path.join(root, 'data', 'generated', topic);

async function main() {
  const adapter = resolveAiAdapter();
  const { dossier, out } = await runResearch({
    topic,
    runDate,
    generatedDir,
    candidatesPath: process.env.CANDIDATES_PATH || path.join(generatedDir, 'candidates-latest.json'),
    promptTemplatePath: path.join(root, 'prompts', 'android-research-ko.md'),
    adapter,
    generatedAt: new Date().toISOString(),
    defaultAudience: 'Android Common Kernel / 벤더 트리 담당자',
  });
  console.log(`Built Android research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), ${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
