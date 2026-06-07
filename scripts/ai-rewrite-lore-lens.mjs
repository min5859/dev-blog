import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { applyTemplate } from './draft-lore-lens.mjs';
import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runWrite } from './lib/write-runner.mjs';

const root = process.cwd();
const topic = process.argv[2] || process.env.TOPIC;
if (!topic) {
  console.error('Usage: node scripts/ai-rewrite-lore-lens.mjs <topicId>');
  process.exit(1);
}

const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();

async function main() {
  const adapter = resolveAiAdapter();
  const pipeline = JSON.parse(await readFile(path.join(root, 'content', 'topics', topic, 'pipeline.json'), 'utf8'));
  if (!pipeline.postIdSuffix) throw new Error(`content/topics/${topic}/pipeline.json: postIdSuffix required`);

  const postId = `${runDate}-${pipeline.postIdSuffix}`;
  const generatedDir = path.join(root, 'data', 'generated', topic);
  const titleTemplate = pipeline.rewriteTitleTemplate || '{{date}} 커널 렌즈 브리핑';
  const titleSuffix = applyTemplate(titleTemplate, { date: '' }).replace(/\s+/g, ' ').trim() || '커널 렌즈 브리핑';

  // lens 고유 draft fallback (pipeline 의 title 템플릿 사용)
  function templateRewrite(draft) {
    const sectionByHeading = new Map(draft.sections.map((section) => [section.heading, section.body]));
    const buckets = draft.draftMetadata?.bucketCounts || {};
    return {
      ...draft,
      title: applyTemplate(titleTemplate, { date: draft.date }),
      summary: `오늘의 핵심: 릴리스 ${buckets.releases ?? 0}건, 회귀·보안 ${buckets.regressions ?? 0}건, 시스템 영향 패치 ${buckets.patches ?? 0}건.`,
      highlights: draft.highlights,
      sections: [
        { heading: '릴리스/로드맵', body: sectionByHeading.get('릴리스/로드맵') || '이번 수집에서 신규 릴리스가 없습니다.' },
        { heading: '회귀·보안 신호', body: sectionByHeading.get('회귀·보안 신호') || '회귀·보안 신호로 분류된 항목이 없습니다.' },
        { heading: '핵심 변경', body: sectionByHeading.get('핵심 변경') || '이번 수집에서 우선 순위가 높은 패치가 분류되지 않았습니다.' },
        { heading: '기타', body: sectionByHeading.get('기타') || '추가 신호가 없습니다.' },
      ],
      confidence: { level: '자동 생성', note: 'AI가 원문 후보와 메타데이터를 요약했습니다. 중요한 판단 전에는 링크된 원문을 확인하세요.' },
      draftMetadata: { ...draft.draftMetadata, lensPipeline: pipeline.pipelineName || topic },
    };
  }

  const { mode } = await runWrite({
    topic,
    postId,
    runDate,
    generatedDir,
    dossierPath: process.env.DOSSIER_PATH || path.join(generatedDir, 'research-latest.json'),
    draftPath: process.env.DRAFT_PATH || path.join(generatedDir, 'draft-latest.json'),
    fallbackDraftPath: path.join(root, 'content', 'topics', topic, 'posts', `${postId}.json`),
    draftPromptPath: path.join(root, 'prompts', 'linux-lens-newsletter-ko.md'),
    dossierPromptPath: path.join(root, 'prompts', 'linux-lens-newsletter-from-dossier-ko.md'),
    dossierMeta: { titleSuffix, tags: pipeline.tags || ['리눅스', '커널'] },
    templateRewrite,
    adapter,
    logLabel: topic,
  });
  console.log(`[${topic}] Rewrote lens newsletter with ${adapter} adapter; mode=${mode}; wrote data/generated/${topic}/rewritten-${postId}.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
