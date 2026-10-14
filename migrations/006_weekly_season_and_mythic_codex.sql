-- 주간 시즌
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS).

-- 세이브마다 "마지막으로 적용된 시즌". 시즌 2 진행 중에 추가된 컬럼이라 기본값 2.
-- 시즌이 바뀐 뒤 처음 정산할 때 서버가 새 시즌을 적용하고 이 값을 올립니다. (game/store.js applyNewSeason)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 2;

-- (예전에 여기서 만들던 mythic_codex 테이블은 007에서 정리했습니다. 신화 도감은 수집모드 발견 기록으로 계산)
