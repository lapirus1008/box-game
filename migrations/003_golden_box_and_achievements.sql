-- 황금 상자 · 수입 2배 버프 · 누적 기록 · 업적 컬럼
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS).
-- 시간 컬럼은 기존 컬럼과 섞어 쓰지 않도록, 값을 넣을 때 항상 별도 파라미터로 넣습니다.
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS golden_box_next_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS income_boost_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifetime_stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS achievements_claimed JSONB NOT NULL DEFAULT '{}'::jsonb;
