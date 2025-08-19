
// ---- Helpers ----
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const menuBtn = $('#menu');
const nav = $('#nav');
const header = $('.site-header');
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openNav() {
  nav.classList.add('open');
  if (!prefersReduced) nav.classList.add('fade-in');
  document.body.style.overflow = 'hidden'; // prevent page scroll while menu open on mobile
}

function closeNav() {
  nav.classList.remove('open', 'fade-in');
  document.body.style.overflow = '';
}

function isNavOpen() {
  return nav.classList.contains('open');
}

// ---- Toggle button ----
menuBtn?.addEventListener('click', () => {
  isNavOpen() ? closeNav() : openNav();
});

// ---- Close on nav link click ----
$('#nav')?.addEventListener('click', (e) => {
  if (e.target.matches('a')) closeNav();
});

// ---- Close on outside click ----
document.addEventListener('click', (e) => {
  if (!isNavOpen()) return;
  const clickedInsideNav = nav.contains(e.target) || menuBtn.contains(e.target);
  if (!clickedInsideNav) closeNav();
});

// ---- Close on ESC ----
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isNavOpen()) closeNav();
});

// ---- Smooth scroll for in-page links (accounts for sticky header) ----
function smoothScrollTo(target) {
  const el = document.getElementById(target);
  if (!el) return;
  const headerH = header?.offsetHeight || 0;
  const y = el.getBoundingClientRect().top + window.scrollY - headerH - 8; // small padding
  if (prefersReduced) {
    window.scrollTo(0, y);
  } else {
    window.scrollTo({ top: y, behavior: 'smooth' });
  }
}

$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href').slice(1);
    if (!id) return;
    const exists = document.getElementById(id);
    if (!exists) return; // allow default if target doesn't exist
    e.preventDefault();
    closeNav();
    smoothScrollTo(id);
    history.pushState(null, '', `#${id}`); // keep URL in sync
  });
});

// ---- Progressive enhancement: add lazy to images if missing ----
$$('img').forEach(img => {
  if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
});
// ===== Events slider: fetch events.json and render cards =====
(async function initEvents(){
  try {
    const res = await fetch('events.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('events.json not found');
    const events = await res.json();

    // Sort by startDate ascending
    events.sort((a,b) => new Date(a.startDate) - new Date(b.startDate));

    const scroller = document.getElementById('events-scroller');
    if (!scroller) return;

    // Render
    scroller.innerHTML = events.map(ev => {
      const date = new Date(ev.startDate);
      const nice = date.toLocaleString('fr-FR', {
        weekday: 'short', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit'
      });
      const img = ev.image || 'images/event-placeholder.jpg';
      const fb = ev.facebook || '#';

      return `
        <article class="event-card">
          <img src="${img}" alt="${ev.title || 'Événement'}">
          <h3>${ev.title || 'Événement KizBourges'}</h3>
          <div class="event-meta">
            <div><strong>${nice}</strong></div>
            ${ev.location ? `<div>${ev.location}</div>` : ``}
          </div>
          <p>${ev.description ? ev.description : ''}</p>
          <div class="event-actions">
            <a class="btn" href="${fb}" target="_blank" rel="noopener">Voir sur Facebook</a>
          </div>
        </article>
      `;
    }).join('');

    // Nav buttons
    const prev = document.querySelector('.events-nav.prev');
    const next = document.querySelector('.events-nav.next');

    const cardWidth = () => {
      const first = scroller.querySelector('.event-card');
      return first ? first.getBoundingClientRect().width + 16 : 320; // +gap
    };

    prev?.addEventListener('click', () => scroller.scrollBy({ left: -cardWidth(), behavior: 'smooth' }));
    next?.addEventListener('click', () => scroller.scrollBy({ left: cardWidth(), behavior: 'smooth' }));

    // Keyboard support
    scroller.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') prev?.click();
      if (e.key === 'ArrowRight') next?.click();
    });

  } catch (e) {
    console.warn('Events load error:', e);
  }
})();

