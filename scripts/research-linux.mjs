import path from 'node:path';

import { resolveAiAdapter } from './lib/ai-rewrite-adapter.mjs';
import { runResearch } from './lib/research-runner.mjs';
import {
  stripPatchPrefix,
  affectedAudienceFor,
  impactTypeFor,
  broadSubsystemsOf,
} from './draft-linux.mjs';

// Design Ref: docs/RESEARCH-WRITE-SPLIT.md §2 — linux 는 draft 헬퍼로 더 풍부한 deterministic
// entry 를 만들 수 있으므로 entryBuilder 를 주입한다(generic 보다 affectedAudience/impactType 정확).

const root = process.cwd();
const topic = 'linux';
const todayKst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const runDate = process.env.NEWSLETTER_DATE || todayKst();
const generatedDir = path.join(root, 'data', 'generated', topic);

function linuxEntry(record) {
  const title = stripPatchPrefix(record.title);
  const subsystems = broadSubsystemsOf(record);
  const commit = String(record.commitMessage || '').trim();
  const firstPara = commit ? commit.split(/\n\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 280) : '';
  const whatChanged = firstPara
    || `${title} — 메타데이터 기준 후보입니다. 구체 변경은 원문에서 확인이 필요합니다.`;
  const whyItMatters = subsystems.length
    ? `${subsystems.join(', ')} 서브시스템에 영향이 갈 수 있습니다.`
    : record.sourceId === 'kernel-org-releases'
      ? `${record.metadata?.moniker || 'release'} 라인을 쓰는 환경에 영향이 갈 수 있습니다.`
      : '시스템 영향 범위는 원문 확인이 필요합니다.';
  return {
    candidateId: record.id,
    title,
    whatChanged,
    whyItMatters,
    affectedAudience: affectedAudienceFor(record),
    impactType: impactTypeFor(record),
    confidence: firstPara ? 'medium' : 'low',
    evidence: [{
      claim: whatChanged.slice(0, 120),
      url: record.url,
      kind: record.sourceId === 'kernel-org-releases' ? 'changelog' : (firstPara ? 'commit' : 'thread'),
      ...(firstPara ? { quote: firstPara.slice(0, 200) } : {}),
    }],
    openQuestions: firstPara ? [] : ['원문 본문 미확인 — write 단계에서 단정 표현 금지'],
  };
}

async function main() {
  const adapter = resolveAiAdapter();
  const { dossier, out } = await runResearch({
    topic,
    runDate,
    generatedDir,
    candidatesPath: process.env.CANDIDATES_PATH || path.join(generatedDir, 'candidates-latest.json'),
    promptTemplatePath: path.join(root, 'prompts', 'linux-research-ko.md'),
    adapter,
    generatedAt: new Date().toISOString(),
    entryBuilder: linuxEntry,
  });
  console.log(
    `Built Linux research dossier with ${adapter} adapter; ${dossier.entries.length} entr(ies), `
    + `${dossier.droppedCandidates?.length || 0} dropped; wrote ${path.relative(root, out)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
