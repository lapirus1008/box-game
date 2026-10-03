// game/config.js
// 게임 밸런스와 관련된 상수, 아이템 목록, 수집가 등급을 한곳에 모아둔 파일입니다.
// 숫자를 조정하고 싶을 때는 이 파일만 고치면 됩니다.

// -------------------------------
// 충전 / 골드 / 합성 / 환생
// -------------------------------
const CHARGE_INTERVAL_MS = 15 * 1000; // 충전 1개가 쌓이는 데 걸리는 시간 (업그레이드 전 기본값)
const MAX_BOX_CHARGES = 100;          // 충전은 최대 이만큼만 쌓입니다 (업그레이드 전 기본값)
const BASE_INCOME_PER_MINUTE = 60;    // 누구나 기본으로 받는 분당 골드

// 아이템 1개당 분당 골드. 모든 아이템이 골드를 벌어서, 상자를 열수록 수입이 오릅니다.
// 합성하면 항상 수입이 오르도록 맞춰져 있습니다. (예: 일반 3개 = 3G → 희귀 1개 = 5G)
const INCOME_PER_MINUTE_BY_RARITY = {
  common: 1,
  rare: 5,
  epic: 20,
  legendary: 80,
  mythic: 500,
};

const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];
// 합성으로 올라갈 수 있는 등급은 일반→희귀→영웅→전설까지입니다.
// 신화는 합성으로 절대 얻을 수 없고, 오직 상자에서만 나옵니다. (전설은 더 이상 합성 재료가 될 수 없음)
const CRAFTABLE_RARITIES = ['common', 'rare', 'epic'];
const CRAFT_COST = 3;                 // 합성에 필요한 같은 아이템 개수

const COMPLETION_BONUS_GOLD = 2000;   // 도감 완성 보상
const REBIRTH_GOLD_REQUIRED = 300000; // 환생에 필요한 골드 (기록모드 전용)
// 랭킹 시즌: 환생 조건 등 규칙이 바뀌면 시즌을 올려서 랭킹을 새로 시작합니다.
// 지난 시즌 기록은 지우지 않고 rebirth_history.season 으로 구분해 보관합니다.
const RANKING_SEASON = 2;
// 시즌별 환생 조건 (랭킹 화면에서 지난 시즌을 볼 때 안내 문구에 씁니다)
const SEASON_GOLD_REQUIRED = { 1: 100000, 2: 300000 };
// 골드로 상자를 즉시 구매할 때의 개당 가격 = max(최소 가격, 지금 분당 수입 × 0.25분(15초치))
// 수입이 커질수록 상자도 비싸져서, "골드가 생기면 무조건 상자"가 정답이 되지 않게 합니다.
const GOLD_PER_BOX_PURCHASE = 75;     // 최소 가격
const BOX_PRICE_INCOME_MINUTES = 0.25;
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
  // 신화 (mythic) - 극악의 확률. 4종이 신화 확률(합계 0.02)을 나눠 갖고, 저마다 강력한 고유 효과가 있습니다
  { key: 'astral_compass', name: '천체의 나침반', rarity: 'mythic', emoji: '🧭', amount: 5000, weight: 0.005, flavor: '전설조차 가리키지 못하는 곳을 가리킨다는, 전해지기만 하던 나침반.' },
  { key: 'ancient_crown',  name: '고대 왕의 왕관', rarity: 'mythic', emoji: '👑', amount: 5000, weight: 0.005, flavor: '이 왕관을 쓴 자의 손에는 언제나 귀한 것만 쥐어졌다고 한다.' },
  { key: 'galaxy_orb',     name: '은하의 구슬',   rarity: 'mythic', emoji: '🌌', amount: 5000, weight: 0.005, flavor: '들여다보면 별들이 소용돌이친다. 황금빛 행운을 끌어당긴다.' },
  { key: 'dragon_pearl',   name: '용왕의 여의주', rarity: 'mythic', emoji: '🐲', amount: 5000, weight: 0.005, flavor: '바라는 것을 이루어 준다는 용왕의 구슬. 값을 깎는 데도 쓸모가 있다.' },
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

// -------------------------------
// 아이템 고유 효과 (보유 개수에 비례, 상한 있음)
// -------------------------------
// type: luck(희귀 이상 등장률 %) · golden(황금 상자 보상 %) · boxDiscount(상자 가격 할인 %)
//       pity(신화 천장 감소 개수) · storageMinutes(보관 시간 분) · incomePercent(전체 수입 %)
// 잠금(🔒)한 아이템은 합성 재료로 쓰이지 않아서 효과를 지킬 수 있습니다.
// 희귀·영웅의 효과(행운·황금 상자·상자 할인)는 신화로 옮겨서, 신화를 뽑는 의미를 키웠습니다.
const ITEM_EFFECTS = {
  star_fragment:  { type: 'pity',           perItem: 10,  max: 1000 },
  hourglass_sand: { type: 'storageMinutes', perItem: 10,  max: 240 },
  astral_compass: { type: 'incomePercent',  perItem: 10,  max: 200 },
  ancient_crown:  { type: 'luck',           perItem: 5,   max: 30 },
  galaxy_orb:     { type: 'golden',         perItem: 20,  max: 100 },
  dragon_pearl:   { type: 'boxDiscount',    perItem: 5,   max: 30 },
};

// -------------------------------
// 골드 업그레이드 (모드별로 따로, 기록모드는 환생/초기화 때 0으로 돌아갑니다)
// -------------------------------
// 가격 = baseCost × 1.5^현재레벨 (내림)
const UPGRADE_COST_GROWTH = 1.5;
const INCOME_BONUS_PERCENT_PER_LEVEL = 10;  // 수입 증가: 레벨당 전체 수입 +10%
const CHARGE_SPEED_MS_PER_LEVEL = 1000;     // 충전 가속: 레벨당 충전 시간 -1초
const MIN_CHARGE_INTERVAL_MS = 5 * 1000;    // 충전 시간은 5초보다 빨라지지 않습니다
const LUCK_PERCENT_PER_LEVEL = 5;           // 행운: 레벨당 희귀 이상 등장률 +5%

// 창고(보관 시간): 자리를 비웠을 때 이 시간까지만 골드·충전·자동 개봉이 쌓입니다.
// (요청이 올 때마다 정산하므로, 접속해 있는 동안에는 사실상 제한이 없습니다)
const HOUR_MS = 60 * 60 * 1000;
const BASE_STORAGE_MS = 4 * HOUR_MS;        // 기본 보관 시간 4시간
const STORAGE_MS_PER_LEVEL = HOUR_MS;       // 창고 레벨당 +1시간

// key는 API와 화면에서, column은 box_claims 테이블에서 쓰입니다.
const UPGRADES = [
  { key: 'income',      column: 'upgrade_income',       name: '수입 증가', emoji: '💰', baseCost: 500,  maxLevel: 30 },
  { key: 'chargeSpeed', column: 'upgrade_charge_speed', name: '충전 가속', emoji: '⚡', baseCost: 1000,
    maxLevel: (CHARGE_INTERVAL_MS - MIN_CHARGE_INTERVAL_MS) / CHARGE_SPEED_MS_PER_LEVEL },
  { key: 'capacity',    column: 'upgrade_capacity',     name: '창고',      emoji: '📦', baseCost: 800,  maxLevel: 20 },
  { key: 'luck',        column: 'upgrade_luck',         name: '행운',      emoji: '🍀', baseCost: 2000, maxLevel: 10 },
];

// -------------------------------
// 자동 개봉 시간 (시간 충전식)
// -------------------------------
// 골드로 시간을 사두면, 그 시간이 남아 있는 동안 충전되는 상자가 자동으로 열립니다.
// 최대 보관 시간(창고)만큼만 채워둘 수 있습니다. 끄면 시간이 줄지 않습니다.
// 1시간 가격 = max(최소 가격, 지금 분당 수입 × 10분) → 수입이 늘어도 적당한 부담이 유지됩니다.
const AUTO_OPEN_MIN_COST_PER_HOUR = 3000;
const AUTO_OPEN_COST_INCOME_MINUTES = 10;

// 자동 합성: 한 번 사면 켜고 끌 수 있습니다. (기록모드는 환생/초기화 때 다시 잠깁니다)
const AUTO_CRAFT = {
  key: 'autoCraft', unlockedColumn: 'auto_craft_unlocked', enabledColumn: 'auto_craft_enabled',
  name: '자동 합성', emoji: '⚙️', cost: 10000, desc: '같은 아이템 3개가 모이면 알아서 합성해요',
};
// 자동 개봉이 한 번에 처리하는 최대 상자 수 (서버 부하 방지)
const MAX_AUTO_OPEN_PER_SYNC = 20000;

// -------------------------------
// 환생 포인트 상점 (기록모드 전용)
// -------------------------------
// 환생할 때 이번 판에 번 골드 5만 G당 1포인트를 받고, 상점에서 영구 특성을 삽니다.
// 특성은 환생해도 사라지지 않습니다.
const PRESTIGE_GOLD_PER_POINT = 50000;
const PRESTIGE_PERKS = [
  { key: 'income',      emoji: '💰', name: '영구 수입',       cost: 1, maxLevel: 100, desc: '전체 수입 +5%' },
  { key: 'startGold',   emoji: '🪙', name: '시작 자금',       cost: 1, maxLevel: 10,  desc: '새 판 시작 골드 +5,000G' },
  { key: 'storage',     emoji: '📦', name: '넓은 창고',       cost: 2, maxLevel: 4,   desc: '보관 시간 +2시간' },
  { key: 'luck',        emoji: '🍀', name: '타고난 행운',     cost: 2, maxLevel: 5,   desc: '희귀 이상 등장률 +5%' },
  { key: 'startAuto',   emoji: '⏳', name: '자동 개봉 비축',  cost: 2, maxLevel: 3,   desc: '새 판 시작 시 자동 개봉 2시간' },
  { key: 'chargeSpeed', emoji: '⚡', name: '빠른 손',         cost: 3, maxLevel: 3,   desc: '충전 시간 -1초' },
  { key: 'autoCraft',   emoji: '⚙️', name: '타고난 장인',     cost: 3, maxLevel: 1,   desc: '새 판을 자동 합성 해금 상태로 시작' },
];
const PERK_INCOME_PERCENT = 5;
const PERK_START_GOLD = 5000;
const PERK_STORAGE_MS = 2 * HOUR_MS;
const PERK_START_AUTO_OPEN_MS = 2 * HOUR_MS;

// -------------------------------
// 황금 상자 (접속해 있을 때만 가끔 나타나는 보너스)
// -------------------------------
// 상태 조회(접속 중) 때 다음 등장 시각을 정해두고, 등장 후 일정 시간 안에 누르면 보상을 줍니다.
const GOLDEN_BOX_MIN_GAP_MS = 3 * 60 * 1000;   // 다음 황금 상자까지 최소 3분
const GOLDEN_BOX_MAX_GAP_MS = 7 * 60 * 1000;   // 최대 7분
const GOLDEN_BOX_WINDOW_MS = 45 * 1000;        // 나타난 뒤 45초 안에 눌러야 함
const GOLDEN_BOX_REWARDS = [
  { key: 'gold',     weight: 40 },  // 분당 수입 × 30분 (최소 3,000G)
  { key: 'boxes',    weight: 25 },  // 상자 100개 즉시 개봉
  { key: 'boost',    weight: 25 },  // 10분간 수입 2배
  { key: 'autoOpen', weight: 10 },  // 자동 개봉 +1시간 (보관 시간이 꽉 찼으면 골드로 대체)
];
const GOLDEN_GOLD_MINUTES = 30;
const GOLDEN_GOLD_MIN = 3000;
const GOLDEN_BOXES = 100;
const INCOME_BOOST_MS = 10 * 60 * 1000;
const INCOME_BOOST_MULTIPLIER = 2;

// -------------------------------
// 업적 (모드별로 따로, 환생해도 사라지지 않습니다)
// -------------------------------
// stat: 어떤 기록으로 진행도를 잴지
//   boxes(연 상자 수) · crafts(합성 횟수) · legendary/mythic(획득 수) · golden(황금 상자)
//   bestIncome(최고 분당 수입) · rebirths(환생 횟수)
// reward: { gold } 또는 { points }(환생 포인트, 기록모드 전용 업적에만)
const ACHIEVEMENTS = [
  { key: 'boxes_1',     stat: 'boxes',      goal: 100,     emoji: '📦', name: '첫 발걸음',     reward: { gold: 2000 } },
  { key: 'boxes_2',     stat: 'boxes',      goal: 1000,    emoji: '📦', name: '상자 수집가',   reward: { gold: 15000 } },
  { key: 'boxes_3',     stat: 'boxes',      goal: 10000,   emoji: '📦', name: '상자 중독',     reward: { gold: 100000 } },
  { key: 'boxes_4',     stat: 'boxes',      goal: 100000,  emoji: '📦', name: '상자의 군주',   reward: { gold: 1000000 } },
  { key: 'crafts_1',    stat: 'crafts',     goal: 50,      emoji: '⚙️', name: '견습 장인',     reward: { gold: 3000 } },
  { key: 'crafts_2',    stat: 'crafts',     goal: 500,     emoji: '⚙️', name: '숙련 장인',     reward: { gold: 30000 } },
  { key: 'crafts_3',    stat: 'crafts',     goal: 5000,    emoji: '⚙️', name: '전설의 장인',   reward: { gold: 300000 } },
  { key: 'legendary_1', stat: 'legendary',  goal: 1,       emoji: '🔥', name: '전설과의 조우', reward: { gold: 5000 } },
  { key: 'legendary_2', stat: 'legendary',  goal: 10,      emoji: '🔥', name: '전설 사냥꾼',   reward: { gold: 30000 } },
  { key: 'legendary_3', stat: 'legendary',  goal: 100,     emoji: '🔥', name: '전설이 된 자',  reward: { gold: 300000 } },
  { key: 'mythic_1',    stat: 'mythic',     goal: 1,       emoji: '🧭', name: '신화의 목격자', reward: { gold: 50000 } },
  { key: 'mythic_2',    stat: 'mythic',     goal: 5,       emoji: '🧭', name: '신화 수집가',   reward: { gold: 500000 } },
  { key: 'income_1',    stat: 'bestIncome', goal: 1000,    emoji: '💰', name: '부자의 길',     reward: { gold: 10000 } },
  { key: 'income_2',    stat: 'bestIncome', goal: 10000,   emoji: '💰', name: '거상',          reward: { gold: 100000 } },
  { key: 'income_3',    stat: 'bestIncome', goal: 100000,  emoji: '💰', name: '황금 제국',     reward: { gold: 1000000 } },
  { key: 'golden_1',    stat: 'golden',     goal: 10,      emoji: '✨', name: '눈치 빠른 손',  reward: { gold: 20000 } },
  { key: 'golden_2',    stat: 'golden',     goal: 100,     emoji: '✨', name: '황금 사냥꾼',   reward: { gold: 200000 } },
  { key: 'rebirth_1',   stat: 'rebirths',   goal: 1,       emoji: '🌀', name: '다시 태어나다', reward: { points: 1 }, recordOnly: true },
  { key: 'rebirth_2',   stat: 'rebirths',   goal: 5,       emoji: '🌀', name: '윤회의 고리',   reward: { points: 2 }, recordOnly: true },
  { key: 'rebirth_3',   stat: 'rebirths',   goal: 20,      emoji: '🌀', name: '영원한 여행자', reward: { points: 3 }, recordOnly: true },
];

// 이 시간 이상 접속하지 않았다가 돌아오면 "자리 비운 동안" 요약을 보여줍니다.
const AWAY_SUMMARY_MIN_MS = 5 * 60 * 1000;

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
  BASE_INCOME_PER_MINUTE,
  INCOME_PER_MINUTE_BY_RARITY,
  RARITY_ORDER,
  CRAFTABLE_RARITIES,
  CRAFT_COST,
  COMPLETION_BONUS_GOLD,
  REBIRTH_GOLD_REQUIRED,
  RANKING_SEASON,
  SEASON_GOLD_REQUIRED,
  GOLD_PER_BOX_PURCHASE,
  BOX_PRICE_INCOME_MINUTES,
  MAX_GOLD_BOX_PURCHASE,
  ITEM_EFFECTS,
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
  UPGRADE_COST_GROWTH,
  INCOME_BONUS_PERCENT_PER_LEVEL,
  CHARGE_SPEED_MS_PER_LEVEL,
  MIN_CHARGE_INTERVAL_MS,
  LUCK_PERCENT_PER_LEVEL,
  HOUR_MS,
  BASE_STORAGE_MS,
  STORAGE_MS_PER_LEVEL,
  UPGRADES,
  AUTO_OPEN_MIN_COST_PER_HOUR,
  AUTO_OPEN_COST_INCOME_MINUTES,
  AUTO_CRAFT,
  MAX_AUTO_OPEN_PER_SYNC,
  PRESTIGE_GOLD_PER_POINT,
  PRESTIGE_PERKS,
  PERK_INCOME_PERCENT,
  PERK_START_GOLD,
  PERK_STORAGE_MS,
  PERK_START_AUTO_OPEN_MS,
  AWAY_SUMMARY_MIN_MS,
  GOLDEN_BOX_MIN_GAP_MS,
  GOLDEN_BOX_MAX_GAP_MS,
  GOLDEN_BOX_WINDOW_MS,
  GOLDEN_BOX_REWARDS,
  GOLDEN_GOLD_MINUTES,
  GOLDEN_GOLD_MIN,
  GOLDEN_BOXES,
  INCOME_BOOST_MS,
  INCOME_BOOST_MULTIPLIER,
  ACHIEVEMENTS,
};
