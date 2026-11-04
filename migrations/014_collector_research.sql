-- 수집가의 연구 (수집모드 전용 장기 강화, game/config.js UPGRADES의 research)
-- 도감을 다 채운 뒤 쌓이는 골드를 쓰는 곳. 레벨당 전체 수입 +5%.
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS upgrade_research INTEGER NOT NULL DEFAULT 0;
