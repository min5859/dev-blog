import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectWeeklyDossier } from './lib/weekly-rollup.mjs';
import { validateDossier } from './lib/dossier-schema.mjs';
import { dossierToPost } from './lib/dossier-to-post.mjs';

// E: 최근 7일 linux dossier 를 모아 주간 롤업 post 를 만든다. (기존 weekly-linux 와 별개 산출물)

const root = process.cwd();
const topic = 'linux';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const endDate = process.env.NEWSLETTER_DATE || todayKst();
const generatedDir = path.join(root, 'data', 'generated', topic);
const days = Number(process.env.ROLLUP_DAYS ?? 7);

async function main() {
  const dossier = await collectWeeklyDossier(generatedDir, endDate, { days, topic, limit: 8 });
  validateDossier(dossier, 'weekly-rollup-linux');

  const postId = `${endDate}-linux-weekly-rollup`;
  const post = dossierToPost(dossier, {
    postId,
    date: endDate,
    topic,
    titleSuffix: '주간 커널 요약',
    tags: ['리눅스', '커널', '주간'],
  });

  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, `weekly-rollup-${endDate}.json`), JSON.stringify({ dossier, post }, null, 2));
  await writeFile(path.join(generatedDir, 'weekly-rollup-latest.json'), JSON.stringify({ dossier, post }, null, 2));

  console.log(
    `Built linux weekly rollup over ${dossier.rollup.daysCovered}/${days} day(s); `
    + `${dossier.entries.length} key entr(ies) from ${dossier.rollup.candidatePool} pooled; wrote weekly-rollup-latest.json`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
