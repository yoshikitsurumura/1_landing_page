// ナビゲーションの開閉（モバイル）
(() => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }
})();

// スクロールアニメーション（IntersectionObserver）
(() => {
  const targets = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || targets.length === 0) {
    targets.forEach(el => el.classList.add('is-visible'));
    return;
  }

  const io = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  targets.forEach(el => io.observe(el));
})();

// ナビのアクティブ表示（スクロールスパイ）
(() => {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
  const map = new Map();
  links.forEach(a => {
    const id = a.getAttribute('href');
    if (!id) return;
    const sec = document.querySelector(id);
    if (sec) map.set(sec, a);
  });

  const clear = () => links.forEach(a => a.classList.remove('active'));

  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          clear();
          const link = map.get(e.target);
          if (link) link.classList.add('active');
        }
      });
    }, { root: null, threshold: 0.5 });

    map.forEach((_, sec) => spy.observe(sec));
  } else {
    // フォールバック
    const onScroll = () => {
      let current = null;
      map.forEach((a, sec) => {
        const rect = sec.getBoundingClientRect();
        if (rect.top <= 120 && rect.bottom >= 120) current = a;
      });
      clear();
      if (current) current.classList.add('active');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();

// Typed.js initialization for hero title
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('hero-title')) {
        const typed = new Typed('#hero-title', {
            strings: ['AI×個別で伸ばす<br>オンライン塾'],
            typeSpeed: 80,
            startDelay: 500,
            loop: false,
            showCursor: false,
            contentType: 'html',
        });
    }
});
