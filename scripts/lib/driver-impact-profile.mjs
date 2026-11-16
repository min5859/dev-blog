// 드라이버 영향 노트의 독자 프로필(config/driver-impact.json)을 읽는다. 수집과 글 조립이 같은 프로필을 써야
// 프로필이 더한 중점 영역(extraAreas)이 양쪽에서 맞는다. 파일이 없으면 중립 프로필이다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileProfile } from './driver-impact.mjs';

export async function loadProfile(root) {
  let raw;
  try {
    raw = await readFile(path.join(root, 'config', 'driver-impact.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return compileProfile();
    throw err;
  }
  return compileProfile(JSON.parse(raw).profile);
}
