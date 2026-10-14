-- 신화 상자: 자동 개봉 중에 나온 신화는 바로 주지 않고 내용물이 정해진 채로 보관했다가,
-- 유저가 직접 눌러서 엽니다. [{ "key": 아이템 key, "at": 나온 시각(ISO), "pity": 천장 여부 }]
-- 유효기간은 없습니다. (기록모드는 환생·초기화·새 시즌 때 그 판의 아이템과 함께 사라짐)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS sealed_mythics JSONB NOT NULL DEFAULT '[]'::jsonb;
