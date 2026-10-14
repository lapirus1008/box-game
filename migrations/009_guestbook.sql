-- 방명록: 로그인한 사람끼리 짧은 글을 남기고 봅니다.
-- 신고가 GUESTBOOK_HIDE_REPORTS(3)개 이상 쌓인 글은 목록에서 숨겨요. 신고한 사람에게는 바로 숨겨집니다.
CREATE TABLE IF NOT EXISTS guestbook_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guestbook_entries_created_idx ON guestbook_entries (id DESC);
CREATE INDEX IF NOT EXISTS guestbook_entries_user_idx ON guestbook_entries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS guestbook_reports (
  entry_id INTEGER NOT NULL REFERENCES guestbook_entries(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, user_id)
);
