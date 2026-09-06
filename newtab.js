// Makes the colour fields behave like something viscous: they shove away
// from the pointer, and they take their time about it. The lag is the whole
// effect -- snapping to position reads as parallax, not liquid.

const layers = Array.prototype.slice.call(document.querySelectorAll('.aurora .layer'));

// Different masses, so they separate as they move instead of sliding as one
// sheet. The heavy one barely budges.
const MASS = [1, 0.62, 0.86];

const HARDEST_PUSH = 260;   // px, at the moment the pointer is right on top
const EASING = 0.055;       // how fast each field catches up to where it wants to be

const now = layers.map(function () { return { x: 0, y: 0 }; });
const want = layers.map(function () { return { x: 0, y: 0 }; });

// Blob centres are measured on resize rather than per frame: reading layout
// three times every frame would stall the very animation it is measuring.
let centres = [];
function measure() {
  centres = layers.map(function (el) {
    const r = el.firstElementChild.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

let pointer = null;
let running = false;

function step() {
  let moving = false;

  for (let i = 0; i < layers.length; i++) {
    const centre = centres[i];
    if (!pointer || !centre) {
      want[i].x = 0;
      want[i].y = 0;
    } else {
      let dx = centre.x + now[i].x - pointer.x;
      let dy = centre.y + now[i].y - pointer.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      // Wide on purpose: a tighter radius means only the nearest field
      // ever reacts and the surface stops reading as one connected body.
      const reach = Math.max(window.innerWidth, window.innerHeight) * 1.15;

      // Squared falloff: almost nothing at the edges of its reach, then it
      // piles on quickly as the pointer closes in.
      const nearness = Math.max(0, 1 - distance / reach);
      const shove = nearness * nearness * HARDEST_PUSH * MASS[i % MASS.length];

      want[i].x = (dx / distance) * shove;
      want[i].y = (dy / distance) * shove;
    }

    now[i].x += (want[i].x - now[i].x) * EASING;
    now[i].y += (want[i].y - now[i].y) * EASING;

    if (Math.abs(want[i].x - now[i].x) > 0.1 || Math.abs(want[i].y - now[i].y) > 0.1) {
      moving = true;
    }
    layers[i].style.transform =
      'translate3d(' + now[i].x.toFixed(2) + 'px,' + now[i].y.toFixed(2) + 'px,0)';
  }

  // Stop burning frames once everything has settled; a pointer move starts
  // it again. This page can sit open for hours.
  if (moving) {
    requestAnimationFrame(step);
  } else {
    running = false;
  }
}

function wake() {
  if (running) return;
  running = true;
  requestAnimationFrame(step);
}

function start() {
  measure();
  window.addEventListener('resize', measure);

  window.addEventListener('mousemove', function (e) {
    pointer = { x: e.clientX, y: e.clientY };
    wake();
  });

  // Pointer gone: let them drift back to where they started.
  window.addEventListener('mouseleave', function () {
    pointer = null;
    wake();
  });
}

// Someone who has asked the system to stop animations gets the still page.
const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!stillness.matches) start();


// ---------- The news feed ----------
// This page has no preload and its policy blocks network calls, both on
// purpose. The browser shell fetches the headlines and calls this through
// executeJavaScript, which is the one way in.

function timeAgo(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + 'd ago';
}

window.__setNews = function (payload) {
  const panel = document.getElementById('news');
  const list = document.getElementById('news-list');
  const topics = document.getElementById('news-topics');
  if (!panel || !list) return;

  if (!payload || payload.enabled === false) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  topics.textContent = (payload.topics || []).join(' \u00b7 ');
  list.textContent = '';

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'news-empty';
    empty.textContent = 'No headlines right now. Check your topics in Settings.';
    list.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    // Anything that is not a plain web link is dropped rather than rendered.
    if (!item || typeof item.link !== 'string' || !/^https?:\/\//i.test(item.link)) return;

    const row = document.createElement('a');
    row.className = 'news-item';
    row.href = item.link;

    const headline = document.createElement('div');
    headline.className = 'news-headline';
    headline.textContent = item.title || item.link;
    row.appendChild(headline);

    const meta = document.createElement('div');
    meta.className = 'news-meta';
    if (item.source) {
      const source = document.createElement('span');
      source.className = 'news-source';
      source.textContent = item.source;
      meta.appendChild(source);
    }
    const when = timeAgo(item.published);
    if (when) {
      const time = document.createElement('span');
      time.textContent = when;
      meta.appendChild(time);
    }
    if (item.topic) {
      const tag = document.createElement('span');
      tag.className = 'news-tag';
      tag.textContent = item.topic;
      meta.appendChild(tag);
    }

    row.appendChild(meta);
    list.appendChild(row);
  });
};
