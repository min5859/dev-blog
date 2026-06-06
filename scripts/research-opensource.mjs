import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runResearch } from './lib/research-runner.mjs';

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — opensource 는 토픽 특화 헬퍼가 없으므로
// research-runner 의 generic entryBuilder 를 그대로 쓴다(claude 경로가 품질을 끌어올림).

const root = process.cwd();
const topic = 'opensource';
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
    promptTemplatePath: path.join(root, 'prompts', 'opensource-research-ko.md'),
    adapter,
    generatedAt: new Date().toISOString(),
    defaultAudience: '오픈소스 도입·평가를 검토하는 개발자',
  });
  console.log(
    `Built opensource research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), `
    + `${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
