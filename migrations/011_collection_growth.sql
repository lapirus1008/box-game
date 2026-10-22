-- 수집모드 성장 요소 (game/collection.js)
-- mythic_shards: 신화 조각 (중복 신화 분해·일일 미션 보상 → 각성·조각 상점에 사용)
-- mythic_awaken: 신화별 각성 단계 { "frost_compass": 2, ... } (★0~5)
-- daily_missions: 오늘의 미션 진행 { "day": 날짜번호, "progress": { key: 횟수 }, "claimed": { key: true } }
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS mythic_shards INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mythic_awaken JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_missions JSONB NOT NULL DEFAULT '{}'::jsonb;
