# CLAUDE.md — 시간의 상자 (box-game)

Claude Code가 이 저장소에서 작업을 시작할 때 읽는 안내입니다. 작업 전에 끝까지 읽고 따릅니다.

## 기록 규칙 (가장 중요)
- 사용자 요청 중 **나중에 다시 확인해야 할 것, 개발에 중요한 결정, 미뤄 둔 할 일**은 항상 저장소의 md 파일에 기록하고 커밋합니다.
  대화에만 남기지 않습니다. (다음 작업에서 이어받을 수 있도록)
  - 결정·할 일·나중에 점검할 것 → `docs/DEVLOG.md`
  - 플레이스토어 출시·운영 절차 → `docs/PLAY_STORE.md`
  - 파일 구조 → `info.txt`
- 작업을 시작하면 `docs/DEVLOG.md`의 "할 일"과 "나중에 점검할 것"을 먼저 확인하고, 조건에 해당하는 항목이 있으면 사용자에게 짚어 줍니다.
- 작업을 끝내면 바뀐 결정·새 할 일·끝난 할 일을 `docs/DEVLOG.md`에 반영합니다.

## 프로젝트 한눈에
- 방치형 수집 게임. 프론트 `public/`(Vercel), 백엔드 Express `server.js`·`routes/`·`lib/`·`game/`(Render), DB PostgreSQL(Neon)
- 게임 로직은 모두 서버가 계산합니다(정산 `game/store.js` settle). 화면은 서버 응답을 보여주기만 합니다.
- DB 구조 변경은 `migrations/NNN_*.sql`(서버 시작 시 자동 적용, 여러 번 실행해도 안전하게 IF NOT EXISTS)
- 실시간 광장은 WebSocket `lib/lobby.js` (서버 메모리, 방 1~9)
- 앱은 TWA(PWABuilder) 포장 — 웹을 고치면 앱도 심사 없이 반영

## 작업 방식
- 브랜치에서 작업 → 푸시 → PR → main에 merge (main 반영 = 배포). 강제 푸시는 쓰지 않습니다.
- 화면 파일을 바꾸면 `public/index.html`의 `style.css?v=…`, `app.js?v=…` 버전을 올립니다(캐시 갱신).
- 확인은 로컬 PostgreSQL + Playwright(휴대폰 크기 360~390px)로 실제 흐름까지 돌려 봅니다.
  로컬 시험용 환경변수: `LOBBY_GOLDEN_GAP_MS`, `LOBBY_RAID_GAP_MS`, `LOBBY_RAID_LIFE_MS`, `LOBBY_ROOM_CAPACITY`, `MAIL_DEV_LOG=1`
- 사용자에게 보이는 문구는 **합쇼체(~습니다/~십시오)**. "~요"로 끝내지 않습니다. 짧은 버튼·표시는 명사형(예: "두드리기").
- 코드 주석은 한국어, 주변 코드의 말투·밀도에 맞춥니다.
- 비밀값(API 키 등)은 채팅·저장소에 넣지 않고 Render Environment에만 둡니다.
