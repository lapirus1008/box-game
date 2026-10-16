-- 신화 선택 상자 (수집모드): 아직 도감에 없는 신화 중 원하는 1종을 골라 받는 상자
-- - 수집가 칭호가 오를 때마다(도감 10·30·60·90종) 1개
-- - 큰 업적(각 업적 계열의 마지막 단계) 보상
-- collector_rank_rewarded: 선택 상자를 이미 받은 칭호 단계(COLLECTOR_RANKS 인덱스). 0 = 아직 없음
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS mythic_choice_boxes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS collector_rank_rewarded INTEGER NOT NULL DEFAULT 0;
