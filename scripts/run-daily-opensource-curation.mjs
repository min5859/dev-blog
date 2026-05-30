import path from 'node:path';

import { DEFAULT_AI_ADAPTER, normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const root = process.cwd();
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);
const rewriteScript = {
  template: 'rewrite:opensource-curation',
  claude: 'rewrite:opensource-curation:claude',
  codex: 'rewrite:opensource-curation:codex',
  cursor: 'rewrite:opensource-curation:cursor',
}[rewriteAdapter] || `rewrite:opensource-curation:${DEFAULT_AI_ADAPTER}`;

const skipUpstream = process.env.OPENSOURCE_CURATION_SKIP_UPSTREAM === '1';
const upstreamSteps = skipUpstream ? [] : [
  ['discover', 'node', [path.join(root, 'scripts', 'opensource-curation', 'discover.mjs')]],
  ['fetch',    'node', [path.join(root, 'scripts', 'opensource-curation', 'fetch.mjs')]],
  ['analyze',  'node', [path.join(root, 'scripts', 'opensource-curation', 'analyze.mjs')]],
];

const steps = [
  ...upstreamSteps,
  ['collect', 'npm', ['run', 'collect:opensource-curation']],
  ['draft',   'npm', ['run', 'draft:opensource-curation']],
  ['rewrite', 'npm', ['run', rewriteScript]],
  ...(shouldPublish ? [['publish', 'npm', ['run', 'publish:opensource-curation']]] : []),
  ['build',   'npm', ['run', 'build']],
];

runPipeline({ topic: 'opensource-curation', logTitle: 'Opensource curation pipeline', steps, runDate, extraStatus: { publishEnabled: shouldPublish } });
