# 플레이스토어 출시 가이드 (시간의 상자)

이 게임은 웹(Vercel)에서 돌아가는 게임이라, 앱을 새로 만들지 않고 **TWA(Trusted Web Activity)** 방식으로 올립니다.
TWA는 크롬 엔진으로 우리 웹 게임을 주소창 없이 전체 화면으로 띄우는 "포장지" 앱입니다.

- 장점: 코드를 다시 만들 필요가 없고, **게임을 고치면 스토어 심사 없이 바로 반영**됩니다. (main 반영 = 앱도 업데이트)
- 다시 앱 파일(.aab)을 올려야 하는 경우: 앱 이름·아이콘·패키지 설정을 바꿀 때, 구글이 요구하는 Android 버전(target API)이 올라갈 때뿐입니다.

---

## 0. 코드 쪽 준비 (완료)
| 항목 | 위치 |
|---|---|
| 앱 설치 정보(PWA manifest) | `public/manifest.webmanifest` |
| 서비스 워커 | `public/sw.js` |
| 앱 아이콘 192/512/maskable | `public/icons/app/` |
| 개인정보처리방침 | `https://box-game-eight-jade.vercel.app/privacy.html` |
| 계정 삭제 (앱 안) | 오른쪽 위 **⚙️ 설정 → 계정 삭제** |
| 계정 삭제 (웹, 스토어 제출용) | `https://box-game-eight-jade.vercel.app/delete-account.html` |
| 사용자 제작 콘텐츠 신고·차단 | 광장: 다른 사람 캐릭터·채팅 줄을 누르면 신고·차단 / 방명록: 글마다 신고·차단 / 설정 → 🚫 차단 목록 |
| 앱 주소창 제거(Digital Asset Links) | `public/.well-known/assetlinks.json` (업로드 키 + 앱 서명 키 지문 등록됨) |
| 스토어 그래픽·스크린샷·설명 문구 | `store/` 폴더, `store/listing.md` |

> 문의 이메일: lapirus1008@gmail.com (개인정보처리방침에 기재됨)

---

## 1. 앱 파일(.aab) 만들기 — PWABuilder (10분)
1. main 반영 후 `https://box-game-eight-jade.vercel.app/manifest.webmanifest` 가 열리는지 확인
2. https://www.pwabuilder.com 접속 → 게임 주소 입력 → **Start**
3. **Package For Stores → Android → Generate Package**
   - Package ID: `com.lapirus.boxgame` (한 번 정하면 못 바꿉니다)
   - App name: `시간의 상자`, Launcher name: `시간의 상자`
   - Version: `1.0.0` / Version code: `1`
   - Signing key: **Create new** (PWABuilder가 만들어 줌)
4. 받은 zip 안의 파일
   - `*.aab` → 플레이 콘솔에 올릴 파일
   - `signing.keystore`, `signing-key-info.txt` → **절대 잃어버리면 안 됨!** (클라우드·USB에 따로 백업)
   - `assetlinks.json` → 3단계에서 사용

## 2. 플레이 콘솔에 앱 만들기
1. Play Console → **앱 만들기**: 앱 이름, 기본 언어 한국어, **게임**, **무료**
2. **테스트 → 비공개 테스트** 트랙에 `.aab` 업로드 (처음엔 프로덕션이 잠겨 있음, 아래 5번 참고)
3. 앱 서명은 기본값(**Google Play 앱 서명**) 그대로 사용

## 3. 주소창 없애기 (Digital Asset Links)
이걸 안 하면 앱 위쪽에 크롬 주소창이 보입니다.
1. Play Console → **설정 → 앱 서명** 맨 아래 **Digital Asset Links JSON** 복사
   (구글이 다시 서명한 키의 SHA-256이 들어 있음. PWABuilder의 assetlinks.json에는 업로드 키만 있음)
2. 두 지문(앱 서명 키 + 업로드 키)을 `store/assetlinks.template.json` 형식으로 합쳐서
   `public/.well-known/assetlinks.json` 으로 저장 → main 반영
3. `https://box-game-eight-jade.vercel.app/.well-known/assetlinks.json` 이 열리는지 확인
   → 이 파일은 저에게 SHA-256 값만 알려주시면 만들어 드릴게요.

## 4. 스토어 등록정보 · 앱 콘텐츠
- **스토어 등록정보**: `store/listing.md` 문구 + `store/` 그래픽
- **개인정보처리방침 URL**: `https://box-game-eight-jade.vercel.app/privacy.html`
- **광고**: 없음
- **앱 액세스 권한**: "일부 기능 로그인 필요" → 심사용 테스트 계정(이메일/비밀번호)을 하나 만들어서 적기
- **콘텐츠 등급(IARC 설문)**: 폭력·선정성 없음. "무작위 아이템" 질문은 **실제 돈으로 살 수 없음(게임 내 화폐만)** 으로 답변
  - 방명록·광장 채팅이 있으므로 "사용자끼리 소통/사용자 생성 콘텐츠 공유" 질문은 **예**
    - 방명록: 신고하면 본인에게 즉시 숨김, 3명 이상 신고 시 전체 숨김, 작성자 차단 가능
    - 광장 채팅: 채팅·사용자 신고(서버 기록·Render 로그 `[REPORT]`), 하루 3명 이상 신고 시 채팅 제한, 사용자 차단
  - 구글 플레이 사용자 제작 콘텐츠(UGC) 정책의 "신고 기능 + 차단 기능" 요건을 앱 안에서 충족합니다.
- **타겟층**: 만 16세 이상(16~17, 18+) 선택 권장 — 13세 미만이 포함되면 '가족 정책' 심사가 추가됨
- **데이터 보안(Data safety)** — 아래처럼 체크
  | 데이터 유형 | 수집 | 용도 | 필수 여부 |
  |---|---|---|---|
  | 개인 정보 → 이메일 주소 | 예 | 계정 관리 | 필수 |
  | 개인 정보 → 사용자 ID (닉네임) | 예 | 앱 기능, 계정 관리 | 필수 |
  | 메시지 → 기타 인앱 메시지 (광장 채팅) | 예 | 앱 기능 | 선택 (광장에 들어갈 때만) |
  | 앱 활동 → 기타 사용자 제작 콘텐츠 (방명록 글) | 예 | 앱 기능 | 선택 |
  | 앱 활동 → 앱 상호작용 (게임 진행 기록, 신고·차단 기록) | 예 | 앱 기능, 사기 방지·보안 | 필수 |
  | 앱 정보 및 성능 → 진단 (화면 오류 기록) | 예 | 분석(문제 해결) | 필수 |
  - 공유: 없음 / 전송 중 암호화: 예(HTTPS)
  - 광장 채팅은 DB에 저장하지 않고 서버 메모리에만 잠시 머묾 (그래도 "수집"에는 체크: 서버로 전송되므로)
  - 계정 삭제 요청 가능: 예 → URL `https://box-game-eight-jade.vercel.app/delete-account.html`

## 5. 비공개 테스트 12명 × 14일 (개인 개발자 계정 필수 조건)
2023년 11월 13일 이후 만든 **개인** 개발자 계정은, 프로덕션(일반 공개) 전에
**테스터 12명 이상이 14일 연속으로 참여한 비공개 테스트**를 해야 합니다. 그 전엔 프로덕션 메뉴가 잠겨 있어요.
- 비공개 테스트 → 테스터: 구글 그룹 또는 이메일 목록으로 12명 이상 등록
  - **테스터 구글 그룹: `lapirus-testers@googlegroups.com`** ("라피루스 앱 테스터", 2026-11-06 생성)
    테스터는 이 그룹에 가입 → 콘솔 참여 링크에서 "테스터 되기" → 스토어에서 설치
- 테스터에게 **참여 링크**를 보내서 "테스터 되기" → 스토어에서 설치까지 하게 하기
- 14일 동안 테스터가 12명 밑으로 떨어지지 않게 유지 (실제로 플레이하는지도 봅니다)
- 14일 후 **프로덕션 액세스 신청** (테스트 소감 등 설문) → 승인되면 프로덕션 출시 → 심사(보통 수일)

## 6. 필수 기술 조건
- 2026년 8월 31일부터 새 앱·업데이트는 **Android 16(API 36) 이상을 target** 해야 합니다.
  PWABuilder 최신 버전은 보통 최신 target으로 만들어 주지만, 업로드 시 경고가 뜨면 PWABuilder에서 다시 생성하세요.

---

## 비밀번호 찾기 메일 설정 (Brevo, 무료 하루 300통)
설정 전에는 비밀번호 찾기를 누르면 "지금은 비밀번호 찾기를 쓸 수 없습니다"가 나옵니다.
1. https://www.brevo.com 가입 (무료)
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: 보내는 사람 이메일(예: 게임용 Gmail) 추가 → 그 메일함에서 인증 링크 클릭
3. **SMTP & API → API Keys → Generate a new API key** → 키 복사
4. Render → 서비스 → **Environment**에 추가하고 저장(자동 재배포)
   - `BREVO_API_KEY` = 3번 키
   - `MAIL_FROM` = 2번에서 인증한 이메일
   - `MAIL_FROM_NAME` = `시간의 상자` (선택)
5. **IP 차단 끄기**: Brevo는 처음 보는 IP의 API 요청을 막고 "unusual IP address" 메일을 보냄.
   Render 서버 IP는 고정이 아니라서 IP 하나만 허용하면 나중에 다시 막힘 →
   메일의 **Stop the review of IP addresses** 또는 Brevo **Settings → Security → Authorized IPs**에서 차단 끄기
6. 게임 로그인 화면 → 비밀번호를 잊으셨습니까? → 내 이메일로 코드가 오는지 확인
   - 안 오면 Render Logs에서 `[MAIL]`로 검색 (실패 이유가 남음), 스팸함도 확인

## 신고 확인 방법 (운영)
- Render → Logs 에서 `[REPORT]` 로 검색하면 신고가 실시간으로 보입니다.
- 쌓인 신고는 Neon SQL Editor 에서:
  ```sql
  SELECT r.created_at, r.context, a.nickname AS 신고자, b.nickname AS 대상, r.message
  FROM user_reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.target_id
  ORDER BY r.created_at DESC LIMIT 50;
  ```

## 나중에 점검할 것 (운영 중 확인)
- **비밀번호 찾기 메일의 보내는 주소 (지금: 개인 Gmail)**
  - 2026-11-10 결정: 우선 개인 Gmail을 `MAIL_FROM`으로 사용. 유저에게 보내는 사람 주소로 보이고, 답장도 그 메일함으로 옴
  - 바꿀 때가 된 신호: "코드 메일이 안 온다/스팸함에 있다" 문의가 반복됨, Render Logs `[MAIL]` 실패가 잦음,
    개인 메일함에 유저 답장이 섞여 불편함, 하루 발송이 Brevo 무료 한도(300통)에 가까워짐
  - 바꾸는 법: 도메인 구입(예: boxgame.kr) → Brevo **Domains**에서 도메인 인증(DNS 레코드 추가) →
    Render `MAIL_FROM`을 `noreply@도메인`으로 변경 (코드 수정 없음). 개인 메일 분리만 원하면 게임 전용 Gmail로 바꿔도 됨

## 출시 전에 꼭 고려할 것 (추천)
1. **서버 잠들기(가장 중요)**: Render 무료 서버는 15분 동안 아무도 안 쓰면 잠들고, 다음 접속 때 깨어나는 데
   **30~60초** 걸립니다. 스토어에서 받은 사람은 "앱이 안 된다"고 생각하고 지울 수 있어요.
   → Render **Starter(월 7달러)** 로 올리거나, 최소한 UptimeRobot 같은 무료 서비스로 `/health`를 10분마다 호출
2. **비밀번호 찾기**가 없습니다. 일반 사용자는 비밀번호를 자주 잊어요. (메일 발송 서비스 연결 필요 — 원하시면 만들어 드릴게요)
3. 스토어 등록정보의 개발자 연락처도 개인정보처리방침과 같은 이메일로 맞추기
4. Neon 무료 요금제는 저장 용량·사용 시간 한도가 있으니 사용자가 늘면 확인
