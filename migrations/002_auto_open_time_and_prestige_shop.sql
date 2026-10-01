-- 자동 개봉을 "시간 충전식"으로, 환생 포인트를 "상점 화폐"로 바꾸기 위한 컬럼
-- 여러 번 실행해도 안전합니다. (기존 자동 개봉 구매자 보상은 컬럼을 처음 만들 때 한 번만 지급)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'box_claims' AND column_name = 'auto_open_remaining_ms'
  ) THEN
    ALTER TABLE box_claims ADD COLUMN auto_open_remaining_ms BIGINT NOT NULL DEFAULT 0;
    -- 이미 자동 개봉을 구매했던 세이브에는 자동 개봉 8시간을 넣어드립니다.
    UPDATE box_claims SET auto_open_remaining_ms = 8 * 60 * 60 * 1000 WHERE auto_open_unlocked = TRUE;
  END IF;
END $$;

ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS prestige_perks JSONB NOT NULL DEFAULT '{}'::jsonb;
