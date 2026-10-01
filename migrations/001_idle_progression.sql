-- 방치형 성장 구조(업그레이드 · 자동화 · 환생 포인트 · 자리 비움 요약)에 필요한 컬럼
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS).
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS upgrade_income       INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upgrade_charge_speed INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upgrade_capacity     INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upgrade_luck         INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_open_unlocked   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_open_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_craft_unlocked  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_craft_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS prestige_points      INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS run_gold_earned      BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_active_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
