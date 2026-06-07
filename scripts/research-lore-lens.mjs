import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runResearch } from './lib/research-runner.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/research-lore-lens.mjs <topicId>');
  process.exit(1);
}

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
    promptTemplatePath: path.join(root, 'prompts', 'linux-lens-research-ko.md'),
    adapter,
    generatedAt: new Date().toISOString(),
    defaultAudience: '해당 커널 서브시스템(렌즈) 추적 담당자',
  });
  console.log(`[${topic}] Built lens research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), ${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
