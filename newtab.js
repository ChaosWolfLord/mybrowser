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
