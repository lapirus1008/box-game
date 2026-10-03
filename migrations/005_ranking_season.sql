-- 랭킹 시즌: 기존 환생 기록은 시즌 1로 보관하고, 랭킹은 현재 시즌(config의 RANKING_SEASON) 기록만 보여줍니다.
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS). 새 기록은 서버가 시즌 번호를 직접 넣습니다.
ALTER TABLE rebirth_history
  ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 1;
