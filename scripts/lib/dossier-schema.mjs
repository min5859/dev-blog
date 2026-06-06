/**
 * Research dossier 의 단일 정의처. research-* 생성기와 write 단계(ai-rewrite-*)가
 * 모두 여기서 import 한다. dossier 는 research agent → write agent 사이의 계약이며,
 * 핵심 불변식은 "본문에 들어갈 모든 주장은 evidence URL 로 추적된다" 이다.
 *
 * 설계: docs/RESEARCH-WRITE-SPLIT.md §3
 */

import { IMPACT_TYPE_VALUES } from './highlight-schema.mjs';

export const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
export const EVIDENCE_KIND_VALUES = new Set(['commit', 'thread', 'changelog', 'cve', 'article']);

const ENTRY_STRING_KEYS = ['candidateId', 'title', 'whatChanged', 'whyItMatters', 'affectedAudience'];

export function isEvidenceUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

/**
 * @param {unknown} item
 * @param {number} index
 * @param {string} where  상위 entry 컨텍스트
 * @throws {Error}
 */
export function validateEvidence(item, index, where) {
  const at = `${where}.evidence[${index}]`;
  if (!item || typeof item !== 'object') {
    throw new Error(`${at} must be an object`);
  }
  for (const key of ['claim', 'kind']) {
    if (typeof item[key] !== 'string' || !item[key]) {
      throw new Error(`${at}.${key} required`);
    }
  }
  if (!isEvidenceUrl(item.url)) {
    throw new Error(`${at}.url must be a real http(s) URL — claims without a source are not allowed (got ${JSON.stringify(item.url)})`);
  }
  if (!EVIDENCE_KIND_VALUES.has(item.kind)) {
    throw new Error(`${at}.kind must be one of ${[...EVIDENCE_KIND_VALUES].join(', ')} (got ${item.kind})`);
  }
  if (item.quote !== undefined) {
    if (typeof item.quote !== 'string') throw new Error(`${at}.quote must be a string`);
    if (item.quote.length > 200) throw new Error(`${at}.quote must be <= 200 chars (got ${item.quote.length})`);
  }
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @param {string} [ctx]
 * @throws {Error}
 */
export function validateDossierEntry(entry, index, ctx = '') {
  const where = ctx ? `${ctx}: entries[${index}]` : `entries[${index}]`;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${where} must be an object`);
  }
  for (const key of ENTRY_STRING_KEYS) {
    if (typeof entry[key] !== 'string' || !entry[key]) {
      throw new Error(`${where}.${key} required`);
    }
  }
  if (!IMPACT_TYPE_VALUES.has(entry.impactType)) {
    throw new Error(`${where}.impactType must be one of ${[...IMPACT_TYPE_VALUES].join(', ')} (got ${entry.impactType})`);
  }
  if (!CONFIDENCE_VALUES.has(entry.confidence)) {
    throw new Error(`${where}.confidence must be high/medium/low (got ${entry.confidence})`);
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    throw new Error(`${where}.evidence must be a non-empty array — every entry needs at least one sourced claim`);
  }
  entry.evidence.forEach((item, i) => validateEvidence(item, i, where));
  if (entry.openQuestions !== undefined) {
    if (!Array.isArray(entry.openQuestions) || entry.openQuestions.some((q) => typeof q !== 'string')) {
      throw new Error(`${where}.openQuestions must be an array of strings`);
    }
  }
}

/**
 * @param {unknown} dossier
 * @param {string} [ctx]
 * @throws {Error}
 */
export function validateDossier(dossier, ctx = '') {
  const prefix = ctx ? `${ctx}: ` : '';
  if (!dossier || typeof dossier !== 'object') {
    throw new Error(`${prefix}dossier must be an object`);
  }
  if (typeof dossier.topic !== 'string' || !dossier.topic) {
    throw new Error(`${prefix}dossier.topic required`);
  }
  if (typeof dossier.date !== 'string' || !dossier.date) {
    throw new Error(`${prefix}dossier.date required`);
  }
  if (!Array.isArray(dossier.entries)) {
    throw new Error(`${prefix}dossier.entries must be an array`);
  }
  dossier.entries.forEach((entry, i) => validateDossierEntry(entry, i, ctx));
  if (dossier.droppedCandidates !== undefined) {
    if (!Array.isArray(dossier.droppedCandidates)) {
      throw new Error(`${prefix}dossier.droppedCandidates must be an array`);
    }
  }
}
