import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScript = {
  template: 'rewrite:ai-coding-agents',
  claude: 'rewrite:ai-coding-agents:claude',
  codex: 'rewrite:ai-coding-agents:codex',
  cursor: 'rewrite:ai-coding-agents:cursor',
}[rewriteAdapter] || `rewrite:ai-coding-agents:${DEFAULT_AI_ADAPTER}`;

const steps = [
  ['collect', 'npm', ['run', 'collect:ai-coding-agents']],
  ['draft',   'npm', ['run', 'draft:ai-coding-agents']],
  ['rewrite', 'npm', ['run', rewriteScript]],
  ...(shouldPublish ? [['publish', 'npm', ['run', 'publish:ai-coding-agents']]] : []),
  ['build',   'npm', ['run', 'build']],
];

runPipeline({ topic: 'ai-coding-agents', logTitle: 'AI 코딩 에이전트 파이프라인', steps, runDate, extraStatus: { publishEnabled: shouldPublish } });
