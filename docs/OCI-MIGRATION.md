# OCI 운영 서버 이주 런북

이 문서는 OCI Linux 서버에 접속한 AI 에이전트가 Dev Blog의 일일 생성과
GitHub Pages 배포 트리거를 현재 PC에서 OCI로 안전하게 이주하기 위한 실행
가이드입니다.

## 1. 목표와 완료 조건

운영 구조는 다음과 같이 유지합니다.

```text
OCI systemd timer (매일 03:00 KST)
  -> scripts/daily-deploy.sh
  -> 11개 일일 토픽 생성/발행
  -> 월요일에는 weekly 추가 생성
  -> content/와 상태 JSON을 main에 commit/push
  -> GitHub Actions pages.yml
  -> GitHub Pages 배포
```

다음 조건을 모두 만족해야 이주가 완료된 것입니다.

- OCI의 전용 `devblog` 사용자로 Node.js, npm, Cursor CLI가 실행됩니다.
- Cursor CLI는 API 종량 과금 키가 아니라 기존 구독 계정의 브라우저 로그인을
  우선 사용합니다.
- `npm ci`, `npm test`, `npm run build`, 비게시 Linux 일일 파이프라인이
  통과합니다.
- OCI의 저장소가 전용 GitHub deploy key로 `main`을 읽고 쓸 수 있습니다.
- `dev-blog.timer`가 매일 03:00 KST로 등록되어 있습니다.
- 기존 Mac LaunchAgent는 중지되어 작성자가 OCI 하나만 남습니다.
- OCI 자동 실행이 이틀 연속 성공하고 GitHub Pages까지 갱신됩니다.

## 2. 2026-08-29 기준 확인된 현재 상태

- 원격 저장소: `git@github.com:min5859/dev-blog.git`
- 게시 브랜치: `main`
- 기본 AI 어댑터: `cursor`
- Cursor 모델: research/write 모두 `composer-2.5`
- 현재 Node.js: `v24.18.0`; 프로젝트 요구사항은 Node.js 20 이상이고
  GitHub Actions도 Node.js 24를 사용합니다.
- 현재 Cursor CLI: `2026.08.25-3e8eec8`
- 실제 Mac 스케줄: 매일 03:00 KST
- 최근 실행 시간: 대략 03:00~04:10 KST
- 일일 대상: 일반 토픽 5개와 Linux lens 6개, 총 11개
- 월요일에는 daily 외에 weekly 콘텐츠도 생성합니다.
- GitHub Actions는 push 후 테스트와 정적 빌드를 수행해 Pages에 배포합니다.

`llm_wiki`의 기존 OCI 기록상 서버는 Ubuntu 기반 Ampere A1(ARM64)입니다.
이 문서는 Ubuntu 24.04를 기준으로 하되, 각 단계에서 실제 OS와 아키텍처를
먼저 확인합니다.

## 3. AI 에이전트 운영 원칙

AI 에이전트는 아래 순서를 지키고, 각 명령의 종료 코드와 핵심 결과를 기록합니다.

1. 기존 파일이나 인증 정보를 서버로 무작정 복사하지 않습니다.
2. 비밀값을 저장소, 셸 히스토리, 로그, 대화에 출력하지 않습니다.
3. 기존 Mac 자동화를 중지하기 전에는 OCI에서 게시 명령이나 timer를 켜지
   않습니다.
4. `git push`, timer 활성화, 기존 Mac LaunchAgent 중지는 사용자 승인을 받은
   뒤 수행합니다.
5. 실패하면 다음 단계로 진행하지 말고 원인, 마지막 성공 단계, 복구 명령을
   보고합니다.
6. 저장소가 깨끗하지 않으면 자동으로 reset하거나 덮어쓰지 않습니다.

다음 네 단계는 사람의 동작 또는 명시적 승인이 필요합니다.

- GitHub 저장소에 OCI deploy public key를 쓰기 허용으로 등록
- 로컬 브라우저에서 Cursor 구독 계정 로그인 승인
- 기존 Mac LaunchAgent 중지
- OCI timer 활성화 또는 첫 게시 실행

## 4. 서버 사전 점검

OCI 서버에서 실행합니다.

```bash
uname -a
uname -m
cat /etc/os-release
df -h /
free -h
timedatectl status
curl -I --max-time 15 https://github.com
curl -I --max-time 15 https://cursor.com
curl -I --max-time 15 https://kernel.org
```

판정 기준:

- `uname -m`은 A1이면 `aarch64`, x86 VM이면 `x86_64`입니다.
- 루트 파일시스템에 최소 10GB 여유를 권장합니다. 현재 로컬 런타임 데이터는
  약 766MB지만 매일 수집 데이터와 로그가 증가합니다.
- 외부로 HTTPS와 SSH 접속이 가능해야 합니다.
- 이 서버는 웹을 직접 서비스하지 않습니다. GitHub Pages가 웹을 호스팅하므로
  OCI 인바운드 80/443 포트를 열 필요가 없습니다. SSH 22만 관리 CIDR에서
  접근 가능하게 유지합니다.

## 5. OS 패키지와 전용 사용자 준비

Ubuntu/Debian이면 다음을 실행합니다.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssh-client xz-utils
```

Oracle Linux 계열이면 다음을 사용합니다.

```bash
sudo dnf install -y ca-certificates curl git openssh-clients tar xz
```

전용 서비스 사용자를 만듭니다. 이미 있으면 생성 명령은 생략합니다.

```bash
id devblog || sudo useradd --create-home --shell /bin/bash devblog
sudo install -d -o devblog -g devblog -m 0755 /srv/dev-blog
```

서비스는 root로 실행하지 않습니다. `/srv/dev-blog`와
`/home/devblog`만 `devblog` 사용자가 쓰도록 합니다.

## 6. Node.js 24 설치

NVM 경로를 systemd에 하드코딩하지 않도록 공식 Node.js 바이너리를
`/opt/node`에 설치하고 `/usr/local/bin`으로 연결합니다. 현재 운영 환경과 같은
`v24.18.0`을 사용합니다.

```bash
DEV_BLOG_NODE_VERSION=v24.18.0
case "$(uname -m)" in
  aarch64|arm64) DEV_BLOG_NODE_ARCH=arm64 ;;
  x86_64|amd64) DEV_BLOG_NODE_ARCH=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

DEV_BLOG_NODE_TMP="$(mktemp -d)"
cd "${DEV_BLOG_NODE_TMP}"
curl -fsSLO "https://nodejs.org/dist/${DEV_BLOG_NODE_VERSION}/node-${DEV_BLOG_NODE_VERSION}-linux-${DEV_BLOG_NODE_ARCH}.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${DEV_BLOG_NODE_VERSION}/SHASUMS256.txt"
grep " node-${DEV_BLOG_NODE_VERSION}-linux-${DEV_BLOG_NODE_ARCH}.tar.xz$" \
  SHASUMS256.txt | sha256sum -c -

sudo install -d -m 0755 /opt/node
sudo tar -xJf "node-${DEV_BLOG_NODE_VERSION}-linux-${DEV_BLOG_NODE_ARCH}.tar.xz" \
  -C /opt/node
sudo ln -sfn "/opt/node/node-${DEV_BLOG_NODE_VERSION}-linux-${DEV_BLOG_NODE_ARCH}" \
  /opt/node/current
sudo ln -sfn /opt/node/current/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node/current/bin/npm /usr/local/bin/npm
sudo ln -sfn /opt/node/current/bin/npx /usr/local/bin/npx

/usr/local/bin/node --version
/usr/local/bin/npm --version

# 위에서 만든 임시 디렉터리인지 값과 경로를 확인한 뒤에만 제거합니다.
test -n "${DEV_BLOG_NODE_TMP}"
test -d "${DEV_BLOG_NODE_TMP}"
rm -rf "${DEV_BLOG_NODE_TMP}"
```

`node --version`이 `v24.18.0`이어야 합니다.

## 7. GitHub 쓰기 권한 준비

개인 SSH 키를 Mac에서 복사하지 말고 이 저장소에만 쓸 수 있는 deploy key를
새로 만듭니다.

```bash
sudo -u devblog -H install -d -m 0700 /home/devblog/.ssh
sudo -u devblog -H ssh-keygen -t ed25519 \
  -f /home/devblog/.ssh/dev-blog_github \
  -C "dev-blog OCI deploy key" -N ""
sudo -u devblog -H sh -c \
  'ssh-keyscan -H github.com >> /home/devblog/.ssh/known_hosts'
sudo chmod 0600 /home/devblog/.ssh/known_hosts
sudo chown devblog:devblog /home/devblog/.ssh/known_hosts
sudo -u devblog -H ssh-keygen -lf /home/devblog/.ssh/known_hosts
sudo cat /home/devblog/.ssh/dev-blog_github.pub
```

출력된 GitHub host key fingerprint를
[GitHub 공식 fingerprint 목록](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)과
대조합니다. 일치하지 않으면 진행하지 않습니다.

여기서 멈추고 사용자에게 public key 등록을 요청합니다.

1. GitHub `min5859/dev-blog` 저장소의 **Settings → Deploy keys**로 이동합니다.
2. 새 key를 추가하고 **Allow write access**를 켭니다.
3. private key는 출력하거나 GitHub에 올리지 않습니다.

등록 완료 후 `/home/devblog/.ssh/config`에 아래 내용을 만듭니다.

```sshconfig
Host github-dev-blog
    HostName github.com
    User git
    IdentityFile /home/devblog/.ssh/dev-blog_github
    IdentitiesOnly yes
```

권한과 연결을 검증합니다.

```bash
sudo chown devblog:devblog /home/devblog/.ssh/config
sudo chmod 0600 /home/devblog/.ssh/config
sudo -u devblog -H git ls-remote \
  git@github-dev-blog:min5859/dev-blog.git HEAD
```

## 8. 저장소 설치

`/srv/dev-blog`가 비어 있는지 먼저 확인한 뒤 clone합니다. 내용이 있으면 삭제하지
말고 사용자에게 확인합니다.

Mac의 `data/raw/`, `data/normalized/`, `data/generated/`, `logs/`, `public/`,
`.cache/`, Cursor 인증/채팅 기록은 복사하지 않습니다. 이들은 재생성 가능하거나
호스트 전용 상태입니다. Git에 추적된 `content/`와 status JSON의 이력은 clone으로
자동 이관됩니다.

```bash
sudo -u devblog -H git clone \
  git@github-dev-blog:min5859/dev-blog.git /srv/dev-blog
cd /srv/dev-blog
sudo -u devblog -H git switch main
sudo -u devblog -H git config pull.ff only
sudo -u devblog -H git config user.name "$(git log -1 --format=%an)"
sudo -u devblog -H git config user.email "$(git log -1 --format=%ae)"
sudo -u devblog -H /usr/local/bin/npm ci
sudo -u devblog -H git push --dry-run origin main
```

clone이 `destination path already exists`로 실패했다면 디렉터리를 자동 삭제하지
않습니다. 기존 파일의 소유자와 출처를 확인한 뒤 별도 경로로 clone합니다.

## 9. Cursor CLI 설치와 구독 로그인

프로젝트 기본 어댑터가 Cursor이므로 `devblog` 사용자 홈에 공식 CLI를
설치합니다. 설치 스크립트는 실행 전 저장하고 검토합니다.

```bash
DEV_BLOG_CURSOR_INSTALLER="$(mktemp)"
curl -fsSL https://cursor.com/install -o "${DEV_BLOG_CURSOR_INSTALLER}"
sed -n '1,220p' "${DEV_BLOG_CURSOR_INSTALLER}"
chmod 0644 "${DEV_BLOG_CURSOR_INSTALLER}"
sudo -u devblog -H bash "${DEV_BLOG_CURSOR_INSTALLER}"
rm -f "${DEV_BLOG_CURSOR_INSTALLER}"
sudo -u devblog -H /home/devblog/.local/bin/agent --version
```

2026-08-29에 공식 설치 endpoint와 기존 Mac 모두
`2026.08.25-3e8eec8`을 제공했습니다. 다른 버전이 설치되면 버전을 기록하고
아래 smoke test를 반드시 통과시킵니다.

구독 기반 실행을 유지하려면 브라우저 로그인을 사용합니다.

```bash
sudo -u devblog -H env NO_OPEN_BROWSER=1 \
  /home/devblog/.local/bin/agent login
```

출력된 URL을 사용자가 로컬 브라우저에서 열고 기존 Cursor 구독 계정으로
승인해야 합니다. 승인이 끝나면 확인합니다.

```bash
sudo -u devblog -H /home/devblog/.local/bin/agent status
```

중요:

- systemd도 동일한 `devblog` 사용자와 `/home/devblog` HOME으로 실행해야 저장된
  로그인을 읽을 수 있습니다.
- 인증 디렉터리를 Mac에서 복사하지 않습니다.
- `CURSOR_API_KEY` 방식은 자동화용 대안이지만 요금 정책이 다를 수 있습니다.
  기존 구독 실행 선호를 지키기 위해 사용자가 명시적으로 승인하지 않으면
  설정하지 않습니다.
- 공식 문서:
  [CLI 설치](https://cursor.com/docs/cli/installation),
  [인증](https://cursor.com/docs/cli/reference/authentication),
  [headless 실행](https://cursor.com/docs/cli/headless)

## 10. 게시 없는 사전 검증

먼저 정적 검증을 실행합니다.

```bash
sudo -u devblog -H env \
  HOME=/home/devblog \
  PATH=/home/devblog/.local/bin:/usr/local/bin:/usr/bin:/bin \
  bash -lc 'cd /srv/dev-blog && npm test && npm run build'
```

그다음 Linux 한 토픽의 전체 파이프라인을 **게시 없이** 실행해 수집, research,
rewrite, build와 Cursor headless 인증을 함께 검증합니다.

```bash
sudo -u devblog -H env \
  HOME=/home/devblog \
  PATH=/home/devblog/.local/bin:/usr/local/bin:/usr/bin:/bin \
  CURSOR_AGENT_BIN=/home/devblog/.local/bin/agent \
  bash -lc 'cd /srv/dev-blog && npm run daily:linux'
```

성공 기준:

- 명령 종료 코드가 0입니다.
- `logs/daily/linux-latest-status.json`의 `ok`가 `true`입니다.
- research와 rewrite 단계가 `cursor`로 완료됩니다.
- `content/`에는 새 게시물이 생기지 않습니다.

smoke test가 변경한 추적 대상 상태 파일만 원복하고 저장소가 깨끗한지 확인합니다.

```bash
cd /srv/dev-blog
sudo -u devblog -H git restore -- logs/daily/linux-latest-status.json
sudo -u devblog -H git status --short
```

출력이 없어야 합니다. 다른 변경이 있으면 자동 원복하지 말고 사용자에게 보고합니다.

## 11. systemd 서비스와 timer 설치

저장소의 unit 파일을 설치합니다.

```bash
sudo install -o root -g root -m 0644 \
  /srv/dev-blog/docs/systemd/dev-blog.service \
  /etc/systemd/system/dev-blog.service
sudo install -o root -g root -m 0644 \
  /srv/dev-blog/docs/systemd/dev-blog.timer \
  /etc/systemd/system/dev-blog.timer
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/dev-blog.service \
  /etc/systemd/system/dev-blog.timer
sudo systemd-analyze calendar '*-*-* 03:00:00 Asia/Seoul'
```

서비스는 실행 전에 `git pull --ff-only`로 운영 코드를 갱신합니다. 로컬 변경이나
브랜치 충돌이 있으면 pull 단계에서 안전하게 실패하고 콘텐츠 생성을 시작하지 않습니다.

timer의 `Persistent=false`는 최초 설치 직후 이미 지난 03:00 작업이 예고 없이
즉시 실행되는 것을 막기 위한 선택입니다. OCI가 03:00에 꺼져 있어 실행을 놓쳤다면
자동 catch-up 대신 아래 수동 복구 절차를 사용합니다.

이 단계에서는 아직 `enable`, `start`, `enable --now`를 실행하지 않습니다.

```bash
systemctl is-enabled dev-blog.timer || true
systemctl is-active dev-blog.timer || true
systemctl list-timers dev-blog.timer
```

## 12. 컷오버

가장 안전한 시점은 기존 Mac의 당일 03:00 실행이 끝나고, 다음 날 03:00 이전입니다.

### 12.1 기존 Mac 자동화 중지

Mac에서 사용자가 실행합니다. plist는 롤백을 위해 삭제하지 않습니다.

```bash
launchctl bootout \
  "gui/$(id -u)" \
  /Users/wooki/Library/LaunchAgents/com.user.dev-blog.daily.plist
launchctl disable \
  "gui/$(id -u)/com.user.dev-blog.daily"
launchctl print \
  "gui/$(id -u)/com.user.dev-blog.daily"
```

마지막 `print`는 서비스가 없다는 오류가 나야 정상입니다. `crontab -l`에도 이
프로젝트의 별도 cron이 없는지 확인합니다.

### 12.2 OCI timer 활성화

기존 Mac이 중지되었다는 사용자 확인을 받은 뒤 OCI에서 실행합니다.

```bash
sudo systemctl enable --now dev-blog.timer
systemctl list-timers dev-blog.timer
```

`NEXT`가 다음 03:00 KST인지 확인합니다. 최초 전체 게시를 즉시 시험하려면 이미
오늘자 글이 있는지 먼저 확인하고, 사용자의 별도 게시 승인을 받은 뒤에만 실행합니다.

```bash
sudo systemctl start dev-blog.service
```

이미 오늘자 게시가 있다면 수동 전체 실행은 생략하고 다음 timer 실행을 기다리는 것이
안전합니다.

## 13. 첫 자동 실행 검증

03:00 이후 OCI에서 확인합니다.

```bash
systemctl status dev-blog.service --no-pager
systemctl show dev-blog.service \
  -p Result -p ExecMainStatus -p ActiveState -p InactiveExitTimestamp
journalctl -u dev-blog.service --since '-3 hours' --no-pager
systemctl list-timers dev-blog.timer
sudo -u devblog -H git -C /srv/dev-blog status --short
sudo -u devblog -H git -C /srv/dev-blog log -3 \
  --date=iso-local --pretty=format:'%h %ad %s'
```

추가 확인:

1. 11개 `logs/daily/*-latest-status.json`의 날짜가 오늘이고 성공/실패 수가
   기대와 맞는지 확인합니다.
2. GitHub Actions의 **Deploy to GitHub Pages** workflow가 성공했는지 확인합니다.
3. `https://min5859.github.io/dev-blog/`에서 오늘자 콘텐츠와 자동 파이프라인
   상태 카드가 갱신됐는지 확인합니다.
4. 월요일에는 daily commit 제목에 weekly가 포함되고 weekly 게시물도 생겼는지
   확인합니다.

`daily-deploy.sh`는 토픽 실패를 격리하므로 service가 exit 0이어도 일부 토픽이
실패할 수 있습니다. journal만 보지 말고 status JSON을 반드시 검사합니다.

이틀 연속 자동 실행과 Pages 배포가 성공하면 이주 완료로 판정합니다.

## 14. 롤백

OCI 자동화를 먼저 멈춥니다.

```bash
sudo systemctl disable --now dev-blog.timer
sudo systemctl stop dev-blog.service
```

실행 중 service를 중지하면 해당 시점의 worktree 상태를 먼저 점검합니다.
추적 변경이나 미푸시 commit을 임의로 버리지 않습니다.

```bash
sudo -u devblog -H git -C /srv/dev-blog status --short
sudo -u devblog -H git -C /srv/dev-blog log \
  --oneline --decorate origin/main..main
```

OCI가 완전히 멈춘 것을 확인한 뒤 Mac에서 LaunchAgent를 복구합니다.

```bash
launchctl enable \
  "gui/$(id -u)/com.user.dev-blog.daily"
launchctl bootstrap \
  "gui/$(id -u)" \
  /Users/wooki/Library/LaunchAgents/com.user.dev-blog.daily.plist
launchctl print \
  "gui/$(id -u)/com.user.dev-blog.daily"
```

같은 날 OCI가 이미 push했다면 Mac에서 즉시 수동 실행하지 말고 다음 정기 실행부터
재개합니다.

## 15. 운영과 장애 복구

### 코드 업데이트

매일 실행 전 unit의 `git pull --ff-only origin main`이 서버 코드를 갱신합니다.
서버에서 운영 코드를 직접 수정하지 않습니다. 로컬 개발 PC에서 수정, 테스트, push한
뒤 OCI가 다음 실행 때 가져오게 합니다.

즉시 반영 확인:

```bash
sudo -u devblog -H git -C /srv/dev-blog pull --ff-only origin main
sudo -u devblog -H /usr/local/bin/npm --prefix /srv/dev-blog ci
sudo -u devblog -H /usr/local/bin/npm --prefix /srv/dev-blog test
```

`package-lock.json`이 바뀐 배포는 `npm ci`가 필요합니다. 정기 unit은 매일 `npm ci`를
하지 않으므로 의존성 변경을 배포할 때 위 명령을 명시적으로 수행합니다.

### 로그

```bash
journalctl -u dev-blog.service -n 300 --no-pager
journalctl -u dev-blog.service -f
ls -lt /srv/dev-blog/logs/daily | head
```

애플리케이션 단계별 로그는 `/srv/dev-blog/logs/daily/`에 남고 systemd의 전체
stdout/stderr는 journal에 남습니다.

### 수동 재실행

같은 날짜에 다시 실행하면 게시 JSON을 다시 만들 수 있습니다. status와 Git history를
확인하고 사용자 승인을 받은 뒤 실행합니다.

```bash
sudo systemctl start dev-blog.service
```

### 자주 발생하는 실패

- `agent: not found`: unit의 PATH와 `CURSOR_AGENT_BIN`, 실제
  `/home/devblog/.local/bin/agent`를 비교합니다.
- `Not authenticated`: `devblog` 사용자로 `agent status`를 확인하고
  `NO_OPEN_BROWSER=1 agent login`을 다시 수행합니다.
- `git push` 권한 오류: deploy key의 **Allow write access**, SSH config,
  origin URL을 확인합니다.
- `git pull --ff-only` 실패: 서버의 변경/미푸시 commit과 `origin/main` 차이를
  조사합니다. reset하지 않습니다.
- 일부 토픽만 누락: 해당 `*-latest-status.json`과
  `logs/ai-rewrite-failures/`를 확인합니다.
- Pages 미갱신: GitHub Actions 실행 결과를 확인합니다. OCI가 정적 사이트를 직접
  호스팅하는 구조가 아닙니다.
- 03:00 실행 누락: timer가 active였는지, 서버가 켜져 있었는지 확인하고 승인 후
  service를 수동 실행합니다.

## 16. AI 에이전트 완료 보고 형식

작업을 마친 AI는 비밀값 없이 다음을 보고합니다.

```text
OCI Dev Blog migration status
- OS / architecture:
- Node / npm version:
- Cursor CLI version and auth status:
- Repository HEAD / worktree cleanliness:
- npm test / build result:
- non-publish daily:linux result:
- GitHub read/write verification:
- Mac LaunchAgent disabled confirmation:
- systemd timer enabled / next trigger:
- first automatic run result (11 topics):
- GitHub Actions / Pages result:
- rollback readiness:
- unresolved risks:
```
