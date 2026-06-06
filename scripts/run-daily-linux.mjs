import path from 'node:path';

import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const root = process.cwd();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScript = {
  template: 'rewrite:linux',
  claude: 'rewrite:linux:claude',
  codex: 'rewrite:linux:codex',
  cursor: 'rewrite:linux:cursor',
}[rewriteAdapter] || `rewrite:linux:${DEFAULT_AI_ADAPTER}`;

// research 단계: 도구 기반 조사는 claude 만 지원, 그 외 어댑터는 deterministic dossier 로 폴백.
const researchScript = rewriteAdapter === 'claude' ? 'research:linux:claude' : 'research:linux';

const steps = [
  ['collect',  'npm', ['run', 'collect:linux']],
  ['draft',    'npm', ['run', 'draft:linux']],
  ['research', 'npm', ['run', researchScript]],
  ['rewrite',  'npm', ['run', rewriteScript]],
  ...(shouldPublish ? [['publish', 'npm', ['run', 'publish:linux']]] : []),
  ['build',    'npm', ['run', 'build']],
];

runPipeline({
  topic: 'linux',
  logTitle: 'Linux daily pipeline',
  steps,
  runDate,
  extraStatus: {
    publishEnabled: shouldPublish,
    outputs: {
      generatedDraft: `data/generated/linux/${runDate}-linux-daily-briefing.json`,
      generatedResearch: `data/generated/linux/research-${runDate}.json`,
      generatedRewrite: `data/generated/linux/rewritten-${runDate}-linux-daily-briefing.json`,
      post: shouldPublish ? `content/topics/linux/posts/${runDate}-linux-daily-briefing.json` : null,
      site: 'public/index.html',
      log: path.join('logs', 'daily', `${runDate}-linux.log`),
    },
  },
});
