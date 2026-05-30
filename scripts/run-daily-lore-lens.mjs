import { normalizeDailyRewriteAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runPipeline } from './lib/run-daily-pipeline.mjs';

const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/run-daily-lore-lens.mjs <topicId>');
  process.exit(1);
}

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const shouldPublish = process.env.PUBLISH_DAILY === '1';
const rewriteAdapter = normalizeDailyRewriteAdapter(process.env.DAILY_REWRITE_ADAPTER);

const steps = [
  ['collect', 'node', ['scripts/collect-lore-lens.mjs', topic]],
  ['draft',   'node', ['scripts/draft-lore-lens.mjs', topic]],
  ['rewrite', 'node', ['scripts/ai-rewrite-lore-lens.mjs', topic], { AI_ADAPTER: rewriteAdapter }],
  ...(shouldPublish ? [['publish', 'node', ['scripts/publish-lore-lens.mjs', topic]]] : []),
  ['build',   'npm',  ['run', 'build']],
];

runPipeline({
  topic,
  logTitle: `Lens daily pipeline ${topic}`,
  steps,
  runDate,
  extraStatus: {
    publishEnabled: shouldPublish,
    outputs: { site: 'public/index.html' },
  },
});
