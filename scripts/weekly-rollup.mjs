import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectWeeklyDossier } from './lib/weekly-rollup.mjs';
import { validateDossier } from './lib/dossier-schema.mjs';
import { dossierToPost } from './lib/dossier-to-post.mjs';

// E(멀티토픽): 토픽 인자로 최근 7일 dossier 를 모아 주간 롤업 post 를 만든다.
// collectWeeklyDossier 는 토픽 범용이므로 토픽 메타(title/tags/sectionPlan)만 주입한다.

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/weekly-rollup.mjs <topic>');
  process.exit(1);
}

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const endDate = process.env.NEWSLETTER_DATE || todayKst();
const days = Number(process.env.ROLLUP_DAYS ?? 7);
const generatedDir = path.join(root, 'data', 'generated', topic);

const CURATION_PICK = '이번 주 선정 (큐레이션)';
const CURATION_BY_IMPACT = Object.fromEntries(
  ['security', 'regression', 'build', 'runtime', 'api-abi', 'backport', 'performance', 'release', 'project'].map((k) => [k, CURATION_PICK]),
);

const TOPIC_META = {
  linux: { titleSuffix: '주간 커널 요약', tags: ['리눅스', '커널', '주간'], postIdSuffix: 'linux-weekly-rollup' },
  opensource: { titleSuffix: '주간 오픈소스 요약', tags: ['오픈소스', 'GitHub', '주간'], postIdSuffix: 'opensource-weekly-rollup' },
  android: { titleSuffix: '주간 Android 커널 요약', tags: ['안드로이드', '커널', '주간'], postIdSuffix: 'android-weekly-rollup' },
  'ai-coding-agents': { titleSuffix: '주간 AI 코딩 에이전트 요약', tags: ['AI', '코딩에이전트', '주간'], postIdSuffix: 'ai-coding-agents-weekly-rollup' },
  'opensource-curation': {
    titleSuffix: '주간 큐레이션 요약', tags: ['opensource-curation', 'github', '주간'], postIdSuffix: 'opensource-curation-weekly-rollup',
    sectionOrder: [CURATION_PICK, '기타'], sectionByImpact: CURATION_BY_IMPACT, emptyOtherText: '큐레이션 선정 외 추가 항목은 없습니다.',
  },
};

async function main() {
  const meta = TOPIC_META[topic] || { titleSuffix: '주간 요약', tags: ['주간'], postIdSuffix: `${topic}-weekly-rollup` };
  const dossier = await collectWeeklyDossier(generatedDir, endDate, { days, topic, limit: 8 });
  validateDossier(dossier, `weekly-rollup-${topic}`);

  const postId = `${endDate}-${meta.postIdSuffix}`;
  const post = dossierToPost(dossier, {
    postId, date: endDate, topic,
    titleSuffix: meta.titleSuffix, tags: meta.tags,
    sectionOrder: meta.sectionOrder, sectionByImpact: meta.sectionByImpact, emptyOtherText: meta.emptyOtherText,
  });

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `weekly-rollup-${endDate}.json`), JSON.stringify({ dossier, post }, null, 2));
  await writeFile(path.join(generatedDir, 'weekly-rollup-latest.json'), JSON.stringify({ dossier, post }, null, 2));

  console.log(`[${topic}] weekly rollup over ${dossier.rollup.daysCovered}/${days} day(s); ${dossier.entries.length} key entr(ies) from ${dossier.rollup.candidatePool} pooled; wrote weekly-rollup-latest.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
