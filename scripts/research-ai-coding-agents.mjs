import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runResearch } from './lib/research-runner.mjs';

const root = process.cwd();
const topic = 'ai-coding-agents';
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
    promptTemplatePath: path.join(root, 'prompts', 'ai-coding-agents-research-ko.md'),
    adapter,
    generatedAt: new Date().toISOString(),
    defaultAudience: 'AI 코딩 에이전트를 도입·평가하는 개발자',
  });
  console.log(`Built AI coding agents research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), ${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
