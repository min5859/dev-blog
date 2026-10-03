# Dev Blog 공용 게시 계정 통합 계획

현재 상태(2026-10-03): 통합 검증과 기존 홈 정리를 완료했습니다. 운영자 요청으로
Dev Blog 관련 백업도 삭제했습니다. 아래 백업 기반 롤백·홈 복구 명령은 과거 기록이며
현재 실행할 수 없습니다. `devblog` 계정은 비활성 상태로 남아 있고 `opc`는 유지합니다.

## 1. 목적

OCI에서 정상 운영 중인 Dev Blog를 전용 `devblog` 계정에서 공용
`wiki-publisher` 계정으로 이전합니다. 서비스와 프로젝트 데이터는 그대로 유지하고
실행 사용자, HOME, Cursor 경로와 GitHub deploy key 소유권만 변경합니다.

```text
Before
  User=devblog
  HOME=/home/devblog
  WorkingDirectory=/srv/dev-blog

After
  User=wiki-publisher
  HOME=/home/wiki-publisher
  WorkingDirectory=/srv/dev-blog
```

## 2. 실행 시점

Research Wiki가 `wiki-publisher` 계정으로 2026-09-29과 09-30 04:00 KST에
2회 연속 실제 게시에 성공했고, OSS Radar의 같은 날 05:00 KST 실행도
성공했습니다. 선행 조건은 충족됐습니다.

권장 작업 창은 2026-09-30 05:30 KST 이후부터 다음 03:00 KST 이전입니다.

## 3. 현재 상태

2026-09-30 기준:

- `/srv/dev-blog`: `devblog:devblog`, 약 274MB
- `/home/devblog`: 약 2.1GB
- `dev-blog.timer`: enabled/active, 매일 03:00 KST
- 최근 service: success, exit 0, commit `9a1e835` 게시
- Git remote: `git@github-dev-blog:min5859/dev-blog.git`
- deploy key: `/home/devblog/.ssh/dev-blog_github`
- Git 작성자: `Wooki Min <min5859@gmail.com>`
- Cursor Agent: `2026.09.26-dd393fe`, 로그인 정상
- `wiki-publisher`도 같은 Cursor 버전과 계정으로 로그인 정상
- 운영 스크립트에는 `/home/devblog` 절대경로가 없고 SSH config만 해당 경로 사용

## 4. 범위

포함:

- GitHub deploy key와 SSH alias를 `wiki-publisher` 홈에 복사
- `/srv/dev-blog` 소유권을 `wiki-publisher`로 변경
- systemd의 `User`, `Group`, `HOME`, `PATH`, `CURSOR_AGENT_BIN` 변경
- Git/Cursor/Node/테스트/비게시 파이프라인 검증
- 검증 성공 후 기존 timer 상태 복구

제외:

- 콘텐츠 재생성 또는 수동 게시
- GitHub deploy key 교체·삭제
- `devblog` 홈이나 계정 삭제
- Dev Blog 코드 구조 변경
- OSS Radar/Research Wiki unit 변경

## 5. 성공 조건

- `wiki-publisher`가 `/srv/dev-blog` 전체를 읽고 쓸 수 있습니다.
- 기존 Git remote와 deploy key로 fetch/push dry-run이 성공합니다.
- 공용 Cursor 로그인으로 비게시 Linux 파이프라인이 성공합니다.
- `npm test`와 `npm run build`가 성공합니다.
- systemd unit이 `wiki-publisher` HOME과 Agent를 사용합니다.
- 저장소가 clean이고 미푸시 commit이 없습니다.
- timer가 다음 03:00 KST를 가리킵니다.
- 실패하면 timer를 켜지 않고 기존 계정으로 롤백합니다.

## 6. 위험과 대응

### GitHub deploy key

deploy key는 `dev-blog` 저장소 쓰기에 사용 중입니다. private key를 출력하지 않고
root 권한으로 복사한 뒤 다음 권한을 강제합니다.

```text
/home/wiki-publisher/.ssh                  0700
dev-blog_github                            0600
config                                     0600
known_hosts                                0600
dev-blog_github.pub                        0644
```

SSH config의 `IdentityFile`만 `/home/wiki-publisher/.ssh/dev-blog_github`로 바꿉니다.
검증 완료 전에는 기존 `/home/devblog/.ssh`를 보존합니다.

### 프로젝트 소유권

`/srv/dev-blog`에는 runtime data, logs와 Git worktree가 함께 있습니다. timer와 service를
중지하고 실행 프로세스가 없는 상태에서만 소유권을 변경합니다. 변경 전 경로, UID/GID,
Git 상태와 systemd unit을 root 전용 백업에 기록합니다.

### 공용 Cursor HOME

`wiki-publisher`의 기존 Cursor 로그인은 그대로 사용합니다. Dev Blog의 Cursor 캐시를
복사하지 않습니다. `scripts/gc-cursor-chats.mjs`는 `/srv/dev-blog`의 정확한 cwd만
대상으로 하므로 다른 프로젝트 세션을 삭제하지 않습니다.

## 7. 실행 절차

### 7.1 중지와 백업

```bash
sudo systemctl disable --now dev-blog.timer
sudo systemctl stop dev-blog.service
pgrep -a -u devblog

sudo install -d -o root -g root -m 0700 \
  /var/backups/wiki-publisher/dev-blog-20260930
sudo cp -a /etc/systemd/system/dev-blog.service \
  /var/backups/wiki-publisher/dev-blog-20260930/
sudo cp -a /etc/systemd/system/dev-blog.service.d \
  /var/backups/wiki-publisher/dev-blog-20260930/
```

### 7.2 deploy key 복사

root가 key와 known_hosts를 `wiki-publisher` 홈으로 복사하고 SSH config의 key 경로만
변경합니다. 다음 명령으로 비대화형 접근을 확인합니다.

```bash
sudo -u wiki-publisher -H git ls-remote \
  git@github-dev-blog:min5859/dev-blog.git HEAD
```

### 7.3 소유권과 systemd 변경

```bash
sudo chown -R wiki-publisher:wiki-publisher /srv/dev-blog
sudo install -o root -g root -m 0644 \
  /srv/dev-blog/docs/systemd/dev-blog.service \
  /etc/systemd/system/dev-blog.service
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/dev-blog.service \
  /etc/systemd/system/dev-blog.timer
```

기존 `oci.conf` drop-in의 네트워크와 `--trust` 설정은 유지합니다.

### 7.4 비게시 검증

```bash
sudo -u wiki-publisher -H /home/wiki-publisher/.local/bin/agent status
sudo -u wiki-publisher -H git -C /srv/dev-blog status --short
sudo -u wiki-publisher -H /usr/local/bin/npm --prefix /srv/dev-blog test
sudo -u wiki-publisher -H /usr/local/bin/npm --prefix /srv/dev-blog run build
sudo -u wiki-publisher -H env \
  HOME=/home/wiki-publisher \
  PATH=/home/wiki-publisher/.local/bin:/usr/local/bin:/usr/bin:/bin \
  CURSOR_AGENT_BIN=/home/wiki-publisher/.local/bin/agent \
  bash -lc 'cd /srv/dev-blog && npm run daily:linux'
sudo -u wiki-publisher -H git -C /srv/dev-blog push --dry-run origin main
```

`npm run daily:linux`는 generated draft까지만 만들고 `content/`에 게시하지 않습니다.
추적 상태 파일이 바뀌면 예상 파일인지 확인하고 임의 reset하지 않습니다.

### 7.5 timer 복구

모든 검증 통과 후에만 활성화합니다.

```bash
sudo systemctl enable --now dev-blog.timer
systemctl list-timers dev-blog.timer
```

## 8. 롤백

```bash
sudo systemctl disable --now dev-blog.timer
sudo systemctl stop dev-blog.service
sudo chown -R devblog:devblog /srv/dev-blog
sudo cp -a \
  /var/backups/wiki-publisher/dev-blog-20260930/dev-blog.service.before \
  /etc/systemd/system/dev-blog.service
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/dev-blog.service \
  /etc/systemd/system/dev-blog.timer
```

기존 deploy key와 `/home/devblog`는 보존되어 있으므로 검증 후 timer를 다시 활성화할
수 있습니다.

## 9. 완료 후 정리

`wiki-publisher`로 2회 이상 실제 게시가 성공한 뒤 진행합니다.

1. `devblog` 계정의 직접 로그인을 잠급니다.
2. 기존 홈과 deploy key를 별도 백업합니다.
3. 일정 보존 기간 후 `devblog` 계정과 중복 Cursor 캐시 삭제를 검토합니다.
4. 삭제 전 `/srv/dev-blog`에 UID/GID 1002 파일이 남았는지 검사합니다.

## 10. 실행 기록

### 2026-09-28 사전 준비

- 운영 서버와 별개인 원격 최신 `main` 기반 임시 worktree에서 계획 작성
- `wiki-publisher`용 systemd 템플릿을 저장소에 반영
- 운영 서버 `/srv/dev-blog`를 latest `main`으로 fast-forward
- Node 테스트 131개 통과
- 새 systemd 템플릿과 기존 timer의 `systemd-analyze verify` 통과
- `/srv/dev-blog` 파일 10,927개가 모두 `devblog` 소유임을 확인
- 기존 설치 unit은 계속 `User=devblog`, timer는 enabled/active 상태 유지
- deploy key, SSH config, 디렉터리 소유권과 인증은 변경하지 않음
- 로컬 기존 checkout은 사용자 commit과 임시 파일이 있어 수정하지 않음

사전 준비 당시 실제 통합은 Research Wiki의 9월 29일·30일 정기 실행과 같은 날
OSS Radar 실행을 확인할 때까지 보류했습니다.

### 2026-09-30 실행 준비 완료

- Dev Blog 03:00 KST: success/0, commit `9a1e835`
- Research Wiki 04:00 KST: 두 번째 연속 성공, Wiki `a1e43e8`
- OSS Radar 05:00 KST: 성공, Wiki `1e7f76d`
- 세 timer 모두 enabled/active, 세 저장소 worktree clean
- 실제 계정·소유권·deploy key·설치 unit 변경은 아직 수행하지 않음

통합 작업은 이 문서의 7장 순서대로 수행하며, 다음 03:00 KST 전까지 검증과 timer
복구를 완료합니다.

### 2026-09-30 계정 통합 실행

계획의 선행 조건을 확인한 뒤 실제 전환을 완료했습니다.

- `dev-blog.timer`를 disable/stop하고 실행 중 `devblog` 프로세스가 없음을 확인
- root 전용 백업 생성:
  `/var/backups/wiki-publisher/dev-blog-20260930`
- 기존 systemd service/timer/drop-in과 `/home/devblog/.ssh` 백업
- deploy key를 이동하지 않고 `/home/wiki-publisher/.ssh`로 복사
- SSH config의 `IdentityFile`만 새 HOME으로 변경
- 기존/복사 공개키 fingerprint 일치 확인
- `wiki-publisher`로 GitHub `ls-remote`와 push dry-run 성공
- `/srv/dev-blog` 항목 11,804개 소유권을 모두
  `wiki-publisher:wiki-publisher`로 변경
- 설치된 systemd service의 `User`, `Group`, `HOME`, `PATH`, Agent 경로 변경
- 기존 `oci.conf` drop-in 유지, `systemd-analyze verify` 통과
- 공용 Cursor Agent `2026.09.28-64d2043` 로그인 정상
- Node 테스트 131개와 정적 사이트 build 성공
- build 결과: 12 topics, 1,627 posts, 537 tags
- `npm run daily:linux` 비게시 검증 성공
- 검증으로 변경된 `logs/daily/linux-latest-status.json` 한 파일만 확인 후 복구
- 최종 worktree clean, 미푸시 commit 없음
- `dev-blog.timer`를 enabled/active로 복구
- 다음 실행: 2026-10-01 03:00 KST

백업 생성 뒤 root 전용 디렉터리의 `*` glob을 일반 셸이 확장하지 못해 권한 정리
명령이 한 번 중단됐습니다.

```text
chmod: cannot access '/var/backups/wiki-publisher/dev-blog-20260930/*'
```

service와 timer는 이미 중지됐지만 운영 파일 변경 전이었고, 백업 파일은 정상
생성돼 있었습니다. `sudo find ... -exec chmod`로 디렉터리 0700, 파일 0600을
적용하고 checksum을 확인한 뒤 계속 진행했습니다.

기존 `/home/devblog`, SSH key와 `devblog` 계정은 롤백용으로 유지합니다. 10월 1일과
2일 03:00 KST 실제 게시가 연속 성공한 뒤 계정 잠금과 중복 홈 정리를 검토합니다.

### 2026-10-03 정기 실행 검증 완료와 기존 계정 정리

- 통합 후 실제 게시 3회 성공: 10월 1일 `6c871a8`, 2일 `88d46b3`,
  3일 `6fbc50d`
- 10월 3일 Dev Blog status 11개 모두 오늘 날짜와 `ok=true` 확인
- 기존 `devblog` 프로세스, 활성 unit/cron/SSH 설정 참조 없음 확인
- `/home/devblog` 밖의 `/home`, `/srv`, `/opt`에 UID/GID 1002 소유 항목 없음 확인
- 홈 전체를 root 전용 압축 백업으로 보존:
  `/var/backups/wiki-publisher/devblog-retired-20261003/home.tar.gz`
- backup mode 0600, 디렉터리 mode 0700, UID/GID와 ACL/xattr 보존
- `gzip -t`, GNU tar의 원본 대조(`--compare`), SHA-256 검증 모두 통과
- 사용되지 않는 Cursor `worker.sock`은 tar가 제외; 일반 파일과 설정은 모두 보존
- `devblog` 계정은 UID/GID 1002를 유지하고 비밀번호 잠금, 계정 만료,
  `/usr/sbin/nologin` 셸 적용
- 검증된 백업 생성 후 `/home/devblog`의 중복 Cursor 설치·캐시·인증·SSH 키 제거
- 원본 약 2.1GB 대신 약 708MiB 압축 백업 보존, 약 1.4GB 절약
- `wiki-publisher`의 기존 SSH 키와 Cursor 로그인 유지 확인
- Git push dry-run 성공, worktree clean, 세 timer 모두 active 유지
- 다음 정기 실행: 2026-10-04 03:00/04:00/05:00 KST

백업에는 로그인 정보와 private key가 들어 있으므로 root 전용으로 보관합니다.
백업은 자동 삭제하지 않습니다. 계정 항목을 남겨 UID 1002의 재사용도 방지합니다.

### 정리 후 홈 복구 절차 (백업 삭제로 현재 사용 불가)

정리가 끝난 현재 8장의 service 롤백을 하려면 먼저 홈과 계정 실행 권한을 복구해야
합니다. 실제 롤백 시 timer를 먼저 중지한 다음 아래 순서로 진행합니다.

```bash
sudo systemctl disable --now dev-blog.timer
sudo systemctl stop dev-blog.service
sudo bash -c 'cd /var/backups/wiki-publisher/devblog-retired-20261003 && sha256sum -c home.tar.gz.sha256'
sudo test ! -e /home/devblog
sudo tar --acls --xattrs --numeric-owner -xzf \
  /var/backups/wiki-publisher/devblog-retired-20261003/home.tar.gz -C /home
sudo usermod -e '' -s /bin/bash devblog
```

비밀번호는 원래도 잠겨 있었으므로 잠금 상태를 유지합니다. 이후 8장의 프로젝트
소유권과 기존 service 복구, Git/Cursor 검증을 마친 뒤 timer를 재활성화합니다.

### 2026-10-03 운영자 요청에 따른 Dev Blog 백업 삭제

- 다음 두 디렉터리를 영구 삭제하고 부재 확인:
  `/var/backups/wiki-publisher/dev-blog-20260930`,
  `/var/backups/wiki-publisher/devblog-retired-20261003`
- 삭제 대상: 기존 홈 압축 백업, SSH 키 백업, 이전 unit/drop-in과 계정 기록
- 약 708MiB 추가 확보; 기존 홈과 인증 정보의 백업 복구 경로는 폐기됨
- 기존 `devblog` 계정은 만료/nologin 상태로 유지
- `opc` 계정·홈·OCI cloud-init 설정은 운영자 지시에 따라 유지
- OSS Radar 계정 변경 백업과 Research Wiki 백업은 삭제하지 않음
- 세 timer 모두 enabled/active, Dev Blog worktree clean 확인

`opc`는 OCI 이미지의 `99-oracle-compute-user-redirect.cfg`에서
`ssh_redirect_user: true`로 생성된 호환 계정입니다. 조사 당시 로그인 이력과 실행
프로세스가 없었으며 홈은 기본 셸 설정과 SSH 설정만 있는 약 24KiB였습니다.
