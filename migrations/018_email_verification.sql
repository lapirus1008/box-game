-- 이메일 인증·변경 (routes/auth.js /email/*)
-- email_verified_at: 이메일을 코드로 확인한 시각 (가입은 인증 없이 그대로, 원하는 사람만 나중에 인증)
-- email_verify_rewarded: 첫 인증 보상을 받았는지 (이메일을 바꿔 다시 인증해도 한 번만)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verify_rewarded BOOLEAN NOT NULL DEFAULT FALSE;

-- 인증·변경용 6자리 코드 (해시만 저장, 15분 만료, 5번 틀리면 무효)
-- purpose: 'verify' = 지금 이메일 인증 / 'change' = 새 이메일로 변경 (email 칸에 새 주소)
CREATE TABLE IF NOT EXISTS email_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_codes_user_idx ON email_codes (user_id, purpose, created_at DESC);

-- 메일 발송 기록: 남의 메일함에 메일을 퍼붓지 못하도록 "받는 주소"마다 발송 횟수를 셉니다.
-- 주소 대신 비밀 키로 만든 해시만 저장하고, 2일 지난 기록은 지웁니다. (계정을 지워도 주소가 남지 않게)
CREATE TABLE IF NOT EXISTS mail_sends (
  id SERIAL PRIMARY KEY,
  email_hash TEXT NOT NULL,
  user_id INTEGER,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mail_sends_email_idx ON mail_sends (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_sends_user_idx ON mail_sends (user_id, purpose, created_at DESC);
