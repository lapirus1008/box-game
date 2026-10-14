-- 신화 도감은 수집모드의 발견 기록(user_discoveries, mode='collection')으로 계산하도록 바꿔서
-- 따로 두던 mythic_codex 테이블은 더 이상 쓰지 않습니다. (기록모드에서 얻은 신화는 도감에 넣지 않음)
DROP TABLE IF EXISTS mythic_codex;

-- 기록모드 구간 기록(스플릿): 이번 판 / 이번 시즌 최고 기록의 구간별 경과 시간(ms)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS run_splits  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS best_splits JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS best_run_ms BIGINT;
