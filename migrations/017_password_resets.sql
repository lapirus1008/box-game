-- 비밀번호 찾기: 이메일로 보낸 6자리 인증 코드 (routes/auth.js /forgot · /reset)
-- 코드는 그대로 저장하지 않고 해시만 저장합니다. 15분 뒤 만료, 5번 틀리면 무효.
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);
