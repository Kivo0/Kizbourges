
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


<script>
// ---- KizBourges Events Loader & Carousel ----
(function(){
  const FEED_URL = 'events.json'; // swap to your proxy later if needed

  // DOM
  const img   = document.getElementById('ev-img');
  const title = document.getElementById('ev-title');
  const when  = document.getElementById('ev-when');
  const where = document.getElementById('ev-where');
  const link  = document.getElementById('ev-link');
  const cta   = document.getElementById('ev-cta');
  const prevB = document.getElementById('ev-prev');
  const nextB = document.getElementById('ev-next');
  const dots  = document.getElementById('ev-dots');
  const list  = document.getElementById('ev-list');

  let events = [];
  let idx = 0;

  function fmtDate(iso){
    try {
      const d = new Date(iso);
      return d.toLocaleString('fr-FR', {
        weekday: 'short', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit'
      });
    } catch { return ''; }
  }

  function renderCarousel(){
    if (!events.length) return;
    const ev = events[idx];

    img.src = ev.cover || 'Images/cover.jpg';
    img.alt = `Affiche : ${ev.name || 'Événement'}`;
    title.textContent = ev.name || 'Événement';
    when.textContent  = ev.start_time ? fmtDate(ev.start_time) : '';
    where.textContent = ev.place?.name ? ev.place.name : '—';
    link.href = ev.event_url || '#';

    cta.innerHTML = '';
    if (ev.ticket_url){
      const a = document.createElement('a');
      a.href = ev.ticket_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'btn';
      a.textContent = 'Billetterie';
      cta.appendChild(a);
    }

    // Update dots
    dots.querySelectorAll('span').forEach((dot, i)=>{
      dot.style.color = (i === idx) ? '#000' : '#ccc';
      dot.style.transform = (i === idx) ? 'scale(1.25)' : 'scale(1)';
    });
  }

  function renderDots(){
    dots.innerHTML = '';
    events.forEach((_, i)=>{
      const s = document.createElement('span');
      s.textContent = '●';
      s.style.cursor = 'pointer';
      s.style.margin = '0 6px';
      s.style.fontSize = '16px';
      s.style.transition = 'transform .2s, color .2s';
      s.addEventListener('click', ()=>{ idx = i; renderCarousel(); });
      dots.appendChild(s);
    });
  }

  function renderList(){
    list.innerHTML = '';
    events.forEach(ev=>{
      const li = document.createElement('div');
      li.className = 'card';
      li.style.display = 'grid';
      li.style.gridTemplateColumns = '120px 1fr';
      li.style.gap = '14px';
      li.style.alignItems = 'center';

      const pic = document.createElement('img');
      pic.src = ev.cover || 'Images/cover.jpg';
      pic.alt = `Affiche : ${ev.name || 'Événement'}`;
      pic.loading = 'lazy';
      pic.style.width = '120px';
      pic.style.height = '80px';
      pic.style.objectFit = 'cover';
      pic.style.borderRadius = '8px';

      const meta = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.textContent = ev.name || 'Événement';
      const p1 = document.createElement('p');
      p1.style.margin = '4px 0';
      p1.textContent = ev.start_time ? fmtDate(ev.start_time) : '';
      const p2 = document.createElement('p');
      p2.style.margin = '2px 0';
      p2.style.color = '#666';
      p2.textContent = ev.place?.name || '—';

      const row = document.createElement('div');
      row.style.marginTop = '6px';
      if (ev.event_url){
        const a1 = document.createElement('a');
        a1.href = ev.event_url; a1.target = '_blank'; a1.rel = 'noopener';
        a1.className = 'btn alt';
        a1.textContent = 'Détails';
        row.appendChild(a1);
      }
      if (ev.ticket_url){
        const a2 = document.createElement('a');
        a2.href = ev.ticket_url; a2.target = '_blank'; a2.rel = 'noopener';
        a2.className = 'btn';
        a2.style.marginLeft = '8px';
        a2.textContent = 'Billets';
        row.appendChild(a2);
      }

      meta.appendChild(h3);
      meta.appendChild(p1);
      meta.appendChild(p2);
      meta.appendChild(row);

      li.appendChild(pic);
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function prev(){ if (!events.length) return; idx = (idx - 1 + events.length) % events.length; renderCarousel(); }
  function next(){ if (!events.length) return; idx = (idx + 1) % events.length; renderCarousel(); }

  prevB.addEventListener('click', prev);
  nextB.addEventListener('click', next);
  document.addEventListener('keydown', (e)=>{ if (e.key === 'ArrowLeft') prev(); if (e.key === 'ArrowRight') next(); });

  fetch(FEED_URL, {cache:'no-store'})
    .then(r => r.json())
    .then(data => {
      // Expecting an array of events
      events = (Array.isArray(data) ? data : data?.data || [])
        .filter(ev => ev && (ev.cover || ev.name))
        // sort by start_time ascending
        .sort((a,b)=> new Date(a.start_time||0) - new Date(b.start_time||0));
      if (!events.length) return;

      renderDots();
      renderCarousel();
      renderList();
    })
    .catch(err => {
      console.error('Events load error:', err);
    });
})();

Papa.parse(CSV_URL, {
  download: true,
  header: true,
  skipEmptyLines: true,
  delimiter: ';', // ← add this if your CSV uses ;
  complete: ({ data }) => { /* ... */ }
});



const CSV_URL = 'kizbourges_events_template1.csv?v=' + Date.now();

</script>
<script>
(function(){
  // Make toggle function global (works with inline onclick and JS binding)
  window.toggleAdhesion = function(e){
    if (e && e.preventDefault) e.preventDefault();
    var s = document.getElementById('adhesion');
    if (!s) return;
    var isHidden = (s.style.display === 'none' || !s.style.display);
    if (isHidden){
      s.style.display = 'block';
      s.scrollIntoView({ behavior: 'smooth' });
    } else {
      s.style.display = 'none';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Robust: any link to #adhesion opens it (desktop-safe)
  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('a[href="#adhesion"]').forEach(function(a){
      a.addEventListener('click', function(ev){
        ev.preventDefault();
        window.toggleAdhesion();
      });
    });
  });

  // Optional: if someone lands on /#adhesion, open it
  if (location.hash === '#adhesion') {
    window.addEventListener('load', function(){ window.toggleAdhesion(); });
  }
})();
</script>



