import { workerArt } from './crew-art.js';

const models = [
  { model: 'Qwen3', size: '1.7B / Q4', shape: 'core' },
  { model: 'EmbeddingGemma', size: '300M / Q4', shape: 'capsule', oneEye: true },
  { model: 'Whisper', size: 'TINY / EN', shape: 'spool' },
  { model: 'Qwen3', size: '8B / Q4 K M', shape: 'prism', oneEye: true }
];
const host = document.createElement('div');
host.className = 'garage-crew';
host.setAttribute('aria-hidden', 'true');
host.setAttribute('inert', '');
document.body.append(host);

const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'crew-toggle';
toggle.id = 'crew-toggle';
toggle.title = 'Pause the decorative garage workers';
document.querySelector('.masthead-right')?.insertBefore(toggle, document.querySelector('.all-apps'));

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = false;
try { paused = localStorage.getItem('modelgarage:crew-paused') === 'true'; } catch {}
let members = [];
let frame = 0;
let destroyed = false;

const pauseIcon = '<path d="M4 2v12M11 2v12"/>';
const playIcon = '<path d="m4 2 9 6-9 6Z"/>';

function syncMotion() {
  const stopped = paused || reduced.matches || document.hidden;
  host.dataset.paused = String(stopped);
  for (const member of members) {
    for (const animation of member.animations) {
      if (stopped || member.route.dataset.visible === 'false') animation.pause();
      else animation.play();
    }
  }
  const label = reduced.matches ? 'Crew resting' : paused ? 'Resume crew' : 'Pause crew';
  toggle.title = reduced.matches ? 'Crew resting for reduced motion' : paused ? 'Resume the decorative garage workers' : 'Pause the decorative garage workers';
  toggle.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${paused ? playIcon : pauseIcon}</svg><span class="crew-toggle-label">${label}</span>`;
  toggle.setAttribute('aria-label', reduced.matches ? 'Crew resting for reduced motion' : label);
  toggle.setAttribute('aria-pressed', String(paused || reduced.matches));
  toggle.disabled = reduced.matches;
}

function rect(selector) {
  const node = document.querySelector(selector);
  if (!node || !node.getClientRects().length) return null;
  const box = node.getBoundingClientRect();
  return { left: box.left + window.scrollX, top: box.top + window.scrollY, right: box.right + window.scrollX, bottom: box.bottom + window.scrollY, width: box.width, height: box.height };
}

function routes() {
  const paths = [];
  const width = document.documentElement.clientWidth;
  const masthead = rect('.masthead');
  const brand = rect('.brand');
  const navigation = rect('.masthead-right');
  const intro = rect('.intro');
  const heading = rect('.intro > div');
  const note = rect('.intro-note');
  const panel = rect('.panel-heading');
  const panelTitle = rect('.panel-heading h2');
  const garage = rect('.garage-illustration');
  const awaiting = rect('.awaiting-result');
  const config = rect('.configurator');
  const report = rect('.report-column');
  const footer = rect('footer');
  if (masthead && brand && navigation && width >= 1000 && navigation.left - brand.right > 240) {
    paths.push({ id: 'roof', x: brand.right + 30, y: masthead.bottom - 66, travel: navigation.left - brand.right - 174, scale: .56, model: 2, seconds: 26, phase: .32 });
  }
  if (intro && heading && note && note.left - heading.right > 128) {
    paths.push({ id: 'courier', x: heading.right + 10, y: intro.top + (intro.height - 84) / 2, travel: Math.max(0, note.left - heading.right - 134), scale: .72, model: 0, seconds: 19, phase: .22 });
  }
  if (panel && panelTitle && panel.right - panelTitle.right > 133) {
    paths.push({ id: 'bench', x: panelTitle.right + 12, y: panel.top + Math.max(0, (panel.height - 75) / 2), travel: panel.right - panelTitle.right - 128, scale: .65, model: 1, seconds: 14, phase: .67 });
  }
  if (garage && awaiting) {
    paths.push({ id: 'bay-core', x: awaiting.left + 26, y: garage.bottom - 86, travel: Math.max(0, awaiting.width - 205), scale: .9, model: 3, seconds: 27, phase: .18 });
    if (awaiting.width > 440) paths.push({ id: 'bay-capsule', x: awaiting.left + 30, y: garage.top + 8, travel: Math.max(0, awaiting.width - 210), scale: .72, model: 2, seconds: 33, phase: .72 });
  } else if (config && report && footer && width > 900 && footer.top - config.bottom > 180) {
    paths.push({ id: 'back-room', x: config.left + 24, y: config.bottom + 35, travel: Math.max(0, config.width - 205), scale: .9, model: 3, seconds: 23, phase: .38 });
  }
  if (footer) paths.push({ id: 'floor', x: footer.left + 20, y: footer.top - 50, travel: Math.max(0, footer.width - 168), scale: .53, model: 2, seconds: 35, phase: .41 });
  return paths;
}

const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) entry.target.dataset.visible = String(entry.isIntersecting);
  syncMotion();
}, { rootMargin: '80px' }) : null;

function layout() {
  frame = 0;
  if (destroyed) return;
  for (const member of members) {
    intersection?.unobserve(member.route);
    for (const animation of member.animations) animation.cancel();
  }
  host.replaceChildren();
  members = [];
  for (const path of routes()) {
    const route = document.createElement('div');
    route.className = 'crew-route';
    route.dataset.cargo = models[path.model].shape;
    route.dataset.route = path.id;
    const worker = document.createElement('div');
    worker.className = 'crew-member';
    const w = 160 * path.scale;
    const h = 112 * path.scale;
    route.style.cssText = `left:${path.x}px;top:${path.y}px;width:${path.travel + w}px;height:${h}px;--crew-width:${w}px;--crew-height:${h}px;--crew-blink-delay:-${path.phase * 6}s;`;
    worker.innerHTML = workerArt(path.id, models[path.model]);
    route.append(worker);
    host.append(route);
    const animations = [];
    if (typeof worker.animate === 'function') {
      const timing = { duration: path.seconds * 1000, iterations: Infinity, easing: 'linear' };
      const walk = worker.animate([
        { transform: 'translateX(0px)', offset: 0 },
        { transform: `translateX(${path.travel}px)`, offset: .44 },
        { transform: `translateX(${path.travel}px)`, offset: .5 },
        { transform: 'translateX(0px)', offset: .94 },
        { transform: 'translateX(0px)', offset: 1 }
      ], timing);
      const facing = [
        { transform: 'scaleX(1)', offset: 0 },
        { transform: 'scaleX(1)', offset: .455 },
        { transform: 'scaleX(-1)', offset: .475 },
        { transform: 'scaleX(-1)', offset: .955 },
        { transform: 'scaleX(1)', offset: .975 },
        { transform: 'scaleX(1)', offset: 1 }
      ];
      animations.push(walk, worker.querySelector('.crew-walk-figure').animate(facing, timing), worker.querySelector('.crew-cargo-label').animate(facing, timing));
      for (const animation of animations) animation.currentTime = path.phase * timing.duration;
    } else worker.style.transform = `translateX(${path.travel * path.phase}px)`;
    members.push({ route, animations });
    intersection?.observe(route);
  }
  syncMotion();
}

function scheduleLayout() { if (!frame && !destroyed) frame = requestAnimationFrame(layout); }

toggle.addEventListener('click', () => {
  paused = !paused;
  try { localStorage.setItem('modelgarage:crew-paused', String(paused)); } catch {}
  syncMotion();
});
document.addEventListener('visibilitychange', syncMotion);
reduced.addEventListener('change', syncMotion);
window.addEventListener('resize', scheduleLayout, { passive: true });
const observer = new ResizeObserver(scheduleLayout);
for (const selector of ['.masthead', '.intro', '.configurator', '.report-column', 'footer']) {
  const node = document.querySelector(selector);
  if (node) observer.observe(node);
}
window.addEventListener('pagehide', event => {
  if (event.persisted) {
    for (const member of members) for (const animation of member.animations) animation.pause();
    return;
  }
  destroyed = true;
  cancelAnimationFrame(frame);
  observer.disconnect();
  intersection?.disconnect();
  for (const member of members) for (const animation of member.animations) animation.cancel();
});
window.addEventListener('pageshow', event => { if (event.persisted) { scheduleLayout(); syncMotion(); } });
document.fonts?.ready.then(scheduleLayout);
scheduleLayout();
