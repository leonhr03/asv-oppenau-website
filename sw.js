const C='asv-v7',F=['./','index.html','news.html','dates.html','youth.html','kontakt.html','impressum.html','stylesheet.css','news.json','dates.json','youth.json','img/logo.png','img/logo-white.png','img/hero-poster.jpg','img/page-hero.jpg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(F))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
