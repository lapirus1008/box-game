-- 상자 충전 수 범위 제한을 넓힙니다.
-- 운영 DB에는 box_charges를 0~100으로 묶는 제한(box_charges_range)이 있었는데,
-- 도감 마일스톤(최대 충전 +20)으로 충전이 100을 넘으면 정산 저장이 거부되어
-- 해당 계정의 게임 화면이 멈춘 것처럼 보였습니다.
ALTER TABLE box_claims DROP CONSTRAINT IF EXISTS box_claims_charges_range;
ALTER TABLE box_claims ADD CONSTRAINT box_claims_charges_range CHECK (box_charges >= 0 AND box_charges <= 1000);
