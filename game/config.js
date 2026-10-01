// game/config.js
// 게임 밸런스와 관련된 상수, 아이템 목록, 수집가 등급을 한곳에 모아둔 파일입니다.
// 숫자를 조정하고 싶을 때는 이 파일만 고치면 됩니다.

// -------------------------------
// 충전 / 골드 / 합성 / 환생
// -------------------------------
const CHARGE_INTERVAL_MS = 15 * 1000; // 충전 1개가 쌓이는 데 걸리는 시간
const MAX_BOX_CHARGES = 100;          // 충전은 최대 이만큼만 쌓입니다
const BASE_INCOME_PER_SECOND = 1;     // 누구나 기본으로 받는 초당 골드

// 등급별로 아이템 1개당 추가되는 초당 골드 (전설/신화만 패시브 수입이 있습니다)
// 신화는 훨씬 희귀해서 더 많이 줍니다.
const INCOME_PER_SECOND_BY_RARITY = {
  legendary: 1,
  mythic: 5,
};

const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];
// 합성으로 올라갈 수 있는 등급은 일반→희귀→영웅→전설까지입니다.
// 신화는 합성으로 절대 얻을 수 없고, 오직 상자에서만 나옵니다. (전설은 더 이상 합성 재료가 될 수 없음)
const CRAFTABLE_RARITIES = ['common', 'rare', 'epic'];
const CRAFT_COST = 3;                 // 합성에 필요한 같은 아이템 개수

const COMPLETION_BONUS_GOLD = 2000;   // 도감 완성 보상
const REBIRTH_GOLD_REQUIRED = 100000; // 환생에 필요한 골드 (기록모드 전용)
const MAX_BULK_OPEN_QUANTITY = MAX_BOX_CHARGES; // 한 번에 열 수 있는 최대 개수 (충전 최대치와 동일)
const GOLD_PER_BOX_PURCHASE = 75;     // 충전과 별개로, 골드를 내고 상자를 즉시 구매할 때의 개당 가격
const MAX_GOLD_BOX_PURCHASE = 2000;
const INITIAL_GOLD = 2000;            // 회원가입 시 지급하는 시작 골드
const RESET_GOLD = 2000;              // 초심으로 돌아가기 / 환생 후 시작 골드

// 신화 천장(피티): 마지막 신화 이후 이만큼 상자를 열면 그 상자는 신화가 100% 확정입니다.
// 신화 자연 확률은 전체 가중치 대비 약 1/5,400 입니다. 3,000개는 자연 확률만으로
// 이 안에 신화를 얻을 확률이 약 42%인 지점이라, "운이 없어도 하루 이틀 열심히 하면 반드시 본다"는
// 느낌을 주면서도 신화의 희소성은 유지합니다. (충전+골드 구매를 병행하면 대략 10시간 안팎)
const MYTHIC_PITY_LIMIT = 3000;

// -------------------------------
// 모드 (기록모드 / 수집모드)
// -------------------------------
const MODES = { RECORD: 'record', COLLECTION: 'collection' };
const VALID_MODES = Object.values(MODES);
const DEFAULT_MODE = MODES.RECORD;

// -------------------------------
// 아이템 목록
// -------------------------------
// weight가 클수록 자주 나옵니다.
// key는 DB(user_items 테이블)에 저장될 고유 식별자라 나중에 함부로 바꾸면 안 됩니다.
const TREASURES = [
  // 일반 (common) - 자주 나옴
  { key: 'rusty_coin',    name: '녹슨 동전',      rarity: 'common',    emoji: '🟤', amount: 10, weight: 30, flavor: '오래된 상인의 지갑에서 나온 듯한 동전.' },
  { key: 'stone_carving', name: '돌 조각상',      rarity: 'common',    emoji: '🗿', amount: 8,  weight: 25, flavor: '투박하지만 정성이 느껴지는 조각.' },
  { key: 'torn_map',      name: '낡은 지도 조각', rarity: 'common',    emoji: '🗺️', amount: 12, weight: 20, flavor: '나머지 조각은 어디에 있을까?' },
  { key: 'small_gem',     name: '작은 보석',      rarity: 'common',    emoji: '💎', amount: 15, weight: 15, flavor: '작지만 은은하게 빛난다.' },
  // 희귀 (rare)
  { key: 'silver_pouch',  name: '은화 주머니',    rarity: 'rare',      emoji: '👛', amount: 40, weight: 6,  flavor: '묵직한 소리가 나는 주머니.' },
  { key: 'lucky_charm',   name: '행운의 부적',    rarity: 'rare',      emoji: '🍀', amount: 45, weight: 5,  flavor: '지니고 있으면 왠지 좋은 일이 생길 것 같다.' },
  { key: 'fairy_wing',    name: '요정의 날개',    rarity: 'rare',      emoji: '🧚', amount: 50, weight: 4,  flavor: '만지면 반짝이는 가루가 떨어진다.' },
  // 영웅 (epic)
  { key: 'dragon_scale',  name: '용의 비늘',      rarity: 'epic',      emoji: '🐉', amount: 150, weight: 1.5, flavor: '믿기 힘들 정도로 단단하다.' },
  { key: 'star_fragment', name: '별의 파편',      rarity: 'epic',      emoji: '✨', amount: 180, weight: 1,   flavor: '밤하늘에서 떨어진 조각이라고 전해진다.' },
  // 전설 (legendary) - 매우 희귀, 갖고 있으면 초당 골드도 추가로 벌립니다
  { key: 'phoenix_feather', name: '불사조의 깃털', rarity: 'legendary', emoji: '🔥', amount: 500, weight: 0.3, flavor: '전설 속에서만 존재한다던 그 깃털.' },
  { key: 'hourglass_sand',  name: '시간의 모래',   rarity: 'legendary', emoji: '⏳', amount: 600, weight: 0.2, flavor: '만지는 순간 시간이 멈춘 듯한 착각이 든다.' },
  // 신화 (mythic) - 극악의 확률, 전설보다도 훨씬 희귀하고 훨씬 많은 초당 골드를 줍니다
  { key: 'astral_compass', name: '천체의 나침반', rarity: 'mythic', emoji: '🧭', amount: 5000, weight: 0.02, flavor: '전설조차 가리키지 못하는 곳을 가리킨다는, 전해지기만 하던 나침반.' },
];

// key → 아이템 정보를 빠르게 찾기 위한 맵
const TREASURE_BY_KEY = new Map(TREASURES.map(t => [t.key, t]));

// -------------------------------
// 수집모드 전용: 아이템 숙련도(★) / 수집가 등급
// -------------------------------
// 같은 아이템을 이 개수만큼 모을 때마다 별이 하나씩 붙습니다. (도감 카드에 표시용)
// 전설/신화 아이템은 별이 붙을 때마다 해당 아이템의 패시브 골드 수입도 함께 늘어나서,
// 도감을 채운 뒤에도 "같은 아이템을 더 모을 이유"가 생깁니다.
const MASTERY_THRESHOLDS = [10, 30, 100, 300]; // 이 개수를 넘길 때마다 ★ +1 (최대 4개)
const MASTERY_INCOME_BONUS_PERCENT_PER_STAR = 10; // ★ 1개당 그 아이템의 수입 +10%

// 도감 발견 개수를 기준으로 한 수집가 등급입니다. 기록모드는 환생/초기화 때마다
// 도감이 비워지므로 사실상 수집모드에서 의미가 있는 시스템입니다.
const COLLECTOR_RANKS = [
  { key: 'novice', name: '초보 수집가',   emoji: '🌱', minObtained: 0 },
  { key: 'bronze', name: '브론즈 수집가', emoji: '🥉', minObtained: Math.ceil(TREASURES.length * 0.25) },
  { key: 'silver', name: '실버 수집가',   emoji: '🥈', minObtained: Math.ceil(TREASURES.length * 0.5) },
  { key: 'gold',   name: '골드 수집가',   emoji: '🥇', minObtained: Math.ceil(TREASURES.length * 0.75) },
  { key: 'master', name: '신화 마스터',   emoji: '👑', minObtained: TREASURES.length },
];

module.exports = {
  CHARGE_INTERVAL_MS,
  MAX_BOX_CHARGES,
  BASE_INCOME_PER_SECOND,
  INCOME_PER_SECOND_BY_RARITY,
  RARITY_ORDER,
  CRAFTABLE_RARITIES,
  CRAFT_COST,
  COMPLETION_BONUS_GOLD,
  REBIRTH_GOLD_REQUIRED,
  MAX_BULK_OPEN_QUANTITY,
  GOLD_PER_BOX_PURCHASE,
  MAX_GOLD_BOX_PURCHASE,
  INITIAL_GOLD,
  RESET_GOLD,
  MYTHIC_PITY_LIMIT,
  MODES,
  VALID_MODES,
  DEFAULT_MODE,
  TREASURES,
  TREASURE_BY_KEY,
  MASTERY_THRESHOLDS,
  MASTERY_INCOME_BONUS_PERCENT_PER_STAR,
  COLLECTOR_RANKS,
};
