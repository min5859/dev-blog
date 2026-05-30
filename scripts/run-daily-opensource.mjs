import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScript = {
  template: 'rewrite:opensource',
  claude: 'rewrite:opensource:claude',
  codex: 'rewrite:opensource:codex',
  cursor: 'rewrite:opensource:cursor',
}[rewriteAdapter] || `rewrite:opensource:${DEFAULT_AI_ADAPTER}`;

const steps = [
  ['collect', 'npm', ['run', 'collect:opensource']],
  ['draft',   'npm', ['run', 'draft:opensource']],
  ['rewrite', 'npm', ['run', rewriteScript]],
  ...(shouldPublish ? [['publish', 'npm', ['run', 'publish:opensource']]] : []),
  ['build',   'npm', ['run', 'build']],
];

runPipeline({ topic: 'opensource', logTitle: 'Opensource trending pipeline', steps, runDate, extraStatus: { publishEnabled: shouldPublish } });
