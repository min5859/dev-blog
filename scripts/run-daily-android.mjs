import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScript = {
  template: 'rewrite:android',
  claude: 'rewrite:android:claude',
  codex: 'rewrite:android:codex',
  cursor: 'rewrite:android:cursor',
}[rewriteAdapter] || `rewrite:android:${DEFAULT_AI_ADAPTER}`;

const steps = [
  ['collect', 'npm', ['run', 'collect:android']],
  ['draft',   'npm', ['run', 'draft:android']],
  ['rewrite', 'npm', ['run', rewriteScript]],
  ...(shouldPublish ? [['publish', 'npm', ['run', 'publish:android']]] : []),
  ['build',   'npm', ['run', 'build']],
];

runPipeline({ topic: 'android', logTitle: 'Android daily pipeline', steps, runDate, extraStatus: { publishEnabled: shouldPublish } });
