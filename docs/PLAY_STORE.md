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
  - 방명록이 있으므로 "사용자끼리 소통/사용자 생성 콘텐츠 공유" 질문은 **예** (신고 기능 있음: 신고하면 본인에게 즉시 숨김, 3명 이상 신고 시 전체 숨김)
- **타겟층**: 만 16세 이상(16~17, 18+) 선택 권장 — 13세 미만이 포함되면 '가족 정책' 심사가 추가됨
- **데이터 보안(Data safety)**
  - 수집: 이메일 주소, 사용자 ID(닉네임), 앱 활동(게임 진행 기록), 앱 활동 → 기타 사용자 생성 콘텐츠(방명록 글)
  - 공유: 없음 / 전송 중 암호화: 예(HTTPS)
  - 계정 삭제 요청 가능: 예 → URL `https://box-game-eight-jade.vercel.app/delete-account.html`

## 5. 비공개 테스트 12명 × 14일 (개인 개발자 계정 필수 조건)
2023년 11월 13일 이후 만든 **개인** 개발자 계정은, 프로덕션(일반 공개) 전에
**테스터 12명 이상이 14일 연속으로 참여한 비공개 테스트**를 해야 합니다. 그 전엔 프로덕션 메뉴가 잠겨 있어요.
- 비공개 테스트 → 테스터: 구글 그룹 또는 이메일 목록으로 12명 이상 등록
- 테스터에게 **참여 링크**를 보내서 "테스터 되기" → 스토어에서 설치까지 하게 하기
- 14일 동안 테스터가 12명 밑으로 떨어지지 않게 유지 (실제로 플레이하는지도 봅니다)
- 14일 후 **프로덕션 액세스 신청** (테스트 소감 등 설문) → 승인되면 프로덕션 출시 → 심사(보통 수일)

## 6. 필수 기술 조건
- 2026년 8월 31일부터 새 앱·업데이트는 **Android 16(API 36) 이상을 target** 해야 합니다.
  PWABuilder 최신 버전은 보통 최신 target으로 만들어 주지만, 업로드 시 경고가 뜨면 PWABuilder에서 다시 생성하세요.

---

## 출시 전에 꼭 고려할 것 (추천)
1. **서버 잠들기(가장 중요)**: Render 무료 서버는 15분 동안 아무도 안 쓰면 잠들고, 다음 접속 때 깨어나는 데
   **30~60초** 걸립니다. 스토어에서 받은 사람은 "앱이 안 된다"고 생각하고 지울 수 있어요.
   → Render **Starter(월 7달러)** 로 올리거나, 최소한 UptimeRobot 같은 무료 서비스로 `/health`를 10분마다 호출
2. **비밀번호 찾기**가 없습니다. 일반 사용자는 비밀번호를 자주 잊어요. (메일 발송 서비스 연결 필요 — 원하시면 만들어 드릴게요)
3. 스토어 등록정보의 개발자 연락처도 개인정보처리방침과 같은 이메일로 맞추기
4. Neon 무료 요금제는 저장 용량·사용 시간 한도가 있으니 사용자가 늘면 확인
