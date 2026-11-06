-- 신고와 차단 (구글 플레이 사용자 제작 콘텐츠 정책: 부적절한 콘텐츠·사용자 신고 + 사용자 차단)
-- user_blocks: 내가 차단한 사람. 차단한 사람의 광장 캐릭터·채팅과 방명록 글이 나에게 보이지 않습니다.
-- user_reports: 광장 채팅·사용자 신고 기록. 서버 로그([REPORT])에도 남고,
--   하루 동안 서로 다른 3명 이상에게 신고받은 사람은 광장 채팅이 잠시 막힙니다. (lib/lobby.js)
CREATE TABLE IF NOT EXISTS user_blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS user_reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context TEXT NOT NULL,          -- 'lobby_chat' · 'lobby_user'
  message TEXT,                   -- 신고한 채팅 내용 (서버가 가진 기록에서 가져옴)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_reports_target_idx ON user_reports (target_id, created_at DESC);
