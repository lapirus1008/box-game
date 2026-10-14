// public/sw.js
// 앱 설치(홈 화면 추가 · 플레이스토어 TWA)를 위한 서비스 워커입니다.
// - 게임 데이터(API)는 항상 서버에서 받아야 하므로 절대 캐시하지 않습니다. (다른 주소라 여기서 처리하지도 않음)
// - 화면 파일(html/js/css)은 "네트워크 먼저": 새로 배포하면 바로 반영되고, 오프라인일 때만 저장본을 씁니다.
// - 아이콘 이미지는 잘 바뀌지 않으므로 "저장본 먼저"로 빠르게 보여줍니다.
// 아이콘을 다시 만들었거나(같은 파일 이름) 화면 파일 구성을 크게 바꿨다면 CACHE_VERSION을 올려주세요.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `box-game-${CACHE_VERSION}`;
const CORE_FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/app/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.includes('/icons/')) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      }))
    );
    return;
  }

  // 화면 파일은 항상 서버에 새 버전이 있는지 확인합니다. (브라우저 캐시의 예전 파일을 쓰지 않도록 no-cache)
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then(cached => cached || caches.match('index.html')))
  );
});
