import { deferDecorativeScenes } from './ui/deferred-scenes.js';
import { initProjects } from './ui/projects.js';
import { initServices } from './ui/services.js';
import { initNewsletter } from './ui/newsletter.js';
import { clamp, sectionProgress, stageAtProgress, stageScrollTarget, safeContactEmail } from './ui/runtime-utils.js';

const root = document.documentElement;
root.classList.add('js');
const hero = document.querySelector('#top');
const heroStage = document.querySelector('#hero-stage');
const process = document.querySelector('#process');
const processStage = document.querySelector('#process-stage');
const header = document.querySelector('#site-header');
const heroCanvas = document.querySelector('#hero-canvas');
const processCanvas = document.querySelector('#process-canvas');
const heroShell = document.querySelector('#hero-scene');
const processShell = document.querySelector('#process-scene');
const stageButtons = [...document.querySelectorAll('#process [data-stage]')];
const hotspotButtons = [...document.querySelectorAll('.process-hotspots [data-stage]')];
const stageDescriptions = [
  'Every project begins with you. We listen, question, and look closely at the way you want to live.',
  'Ideas take shape through sketches, models, and conversation. We explore the possibilities that make your place distinctive.',
  'We bring the vision into focus. Light, proportion, materials, and detail find their place in a considered whole.',
  'Every detail has a purpose. We work closely with makers, consultants, and craftspeople to turn intent into a clear plan.',
  'Ideas become places. Through careful collaboration on site, we carry the design into the life it was made for.',
];
const cleanup = [];
const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
let storedMotion = null;
try { storedMotion = localStorage.getItem('groundwork-motion'); } catch { /* Storage is optional. */ }
let motionEnabled = storedMotion === 'on' || (storedMotion !== 'off' && !preference.matches);
let heroScene = null;
let processScene = null;
let createHeroCity = null;
let createProcessStack = null;
let frame = 0;
let disposed = false;
let dirty = true;
let previousTime = performance.now();
let elapsed = 0;
let heroProgress = 0;
let targetHeroProgress = 0;
let processProgress = 0;
let targetProcessProgress = 0;
let heroVisible = true;
let processVisible = false;
let activeStage = -1;
let stageOverride = null;
let pointerX = 0;
let pointerY = 0;
let processBounds = { top: 0, height: 0 };
let processPinned = false;

function on(target, type, listener, options) {
  target?.addEventListener(type, listener, options);
  cleanup.push(() => target?.removeEventListener(type, listener, options));
}

function schedule() {
  if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(render);
}

function invalidate() {
  dirty = true;
  schedule();
}

function createScene(factory, canvas, shell) {
  if (!canvas || !shell) return null;
  shell.classList.remove('is-ready', 'is-unavailable');
  try {
    // Probe the actual canvas first: unsupported browsers keep the CSS architecture illustration.
    const context = canvas.getContext('webgl2', {
      alpha: true,
      antialias: canvas === processCanvas,
      powerPreference: 'low-power',
    });
    if (!context) throw new Error('WebGL is unavailable.');
    const scene = factory({ canvas, reducedMotion: !motionEnabled });
    shell.classList.add('is-ready');
    return scene;
  } catch {
    shell.classList.add('is-unavailable');
    return null;
  }
}

function createScenes() {
  if (!createHeroCity || !createProcessStack) { invalidate(); return; }
  heroScene?.dispose();
  processScene?.dispose();
  heroScene = createScene(createHeroCity, heroCanvas, heroShell);
  processScene = createScene(createProcessStack, processCanvas, processShell);
  invalidate();
}

function applyMotion() {
  root.dataset.motion = motionEnabled ? 'on' : 'off';
  root.classList.toggle('motion-reduced', !motionEnabled);
  const button = document.querySelector('#motion-toggle');
  button?.setAttribute('aria-pressed', String(motionEnabled));
  const state = document.querySelector('#motion-state');
  if (state) state.textContent = motionEnabled ? 'on' : 'off';
}

function selectStage(index) {
  const next = Math.round(clamp(index, 0, stageDescriptions.length - 1));
  if (next === activeStage) return;
  activeStage = next;
  stageButtons.forEach((button) => {
    if (Number(button.dataset.stage) === next) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  const number = document.querySelector('#process-number');
  const description = document.querySelector('#process-description');
  if (number) number.textContent = `${String(next + 1).padStart(2, '0')} / 05`;
  if (description) description.textContent = stageDescriptions[next];
  process?.style.setProperty('--active-stage', String(next));
}

function measure() {
  const viewport = window.innerHeight;
  const heroBounds = hero.getBoundingClientRect();
  const bounds = process.getBoundingClientRect();
  heroVisible = heroBounds.bottom > 0 && heroBounds.top < viewport;
  processVisible = bounds.bottom > 0 && bounds.top < viewport;
  targetHeroProgress = sectionProgress(heroBounds.top, heroBounds.height, viewport);
  processBounds = { top: bounds.top + window.scrollY, height: bounds.height };
  processPinned = getComputedStyle(processStage).position === 'sticky';
  targetProcessProgress = !processPinned
    ? clamp((viewport * 0.65 - bounds.top) / Math.max(1, bounds.height * 0.72))
    : sectionProgress(bounds.top, bounds.height, viewport);
  header?.classList.toggle('is-scrolled', window.scrollY > 24);
  dirty = false;
}

function updateHotspots() {
  if (!processScene) return;
  const hotspots = processScene.getHotspots();
  const height = Math.max(1, processCanvas.clientHeight);
  const margin = 23 / height;
  const separation = 44 / height;
  const placements = hotspots.map((point, index) => ({ ...point, index, y: clamp(point.y, margin, 1 - margin) }))
    .sort((a, b) => a.y - b.y);
  // Preserve projected ordering while keeping the five controls independently tappable.
  placements.forEach((point, index) => {
    if (index) point.y = Math.max(point.y, placements[index - 1].y + separation);
  });
  const overflow = Math.max(0, placements.at(-1).y - (1 - margin));
  placements.forEach((point) => { point.y -= overflow; });
  hotspotButtons.forEach((button, index) => {
    const point = placements.find((placement) => placement.index === index);
    if (!point) return;
    button.style.left = `${clamp(point.x, 0.04, 0.96) * 100}%`;
    button.style.top = `${clamp(point.y, 0.04, 0.96) * 100}%`;
    button.style.visibility = point.visible ? 'visible' : 'hidden';
  });
}

// This is the only animation loop for the optional Three.js scenes.
function render(now) {
  frame = 0;
  if (disposed || document.hidden) return;
  const delta = Math.min(0.05, Math.max(0, (now - previousTime) / 1000));
  previousTime = now;
  if (motionEnabled) elapsed += delta;
  if (dirty) measure();
  const ease = motionEnabled ? 1 - Math.exp(-delta * 11) : 1;
  heroProgress += (targetHeroProgress - heroProgress) * ease;
  processProgress += (targetProcessProgress - processProgress) * ease;
  if (Math.abs(heroProgress - targetHeroProgress) < 0.0001) heroProgress = targetHeroProgress;
  if (Math.abs(processProgress - targetProcessProgress) < 0.0001) processProgress = targetProcessProgress;
  heroStage.style.setProperty('--hero-exit', String(motionEnabled ? clamp((heroProgress - 0.12) / 0.72) : 0));
  if (stageOverride && processPinned
    && (Math.abs(window.scrollY - stageOverride.target) < 3 || now > stageOverride.until)) stageOverride = null;
  selectStage(stageOverride ? stageOverride.index : stageAtProgress(targetProcessProgress));

  if (heroVisible && heroScene) heroScene.render({ time: elapsed, progress: heroProgress, pointerX, pointerY });
  if (processVisible && processScene) {
    processScene.render({ time: elapsed, progress: stageOverride ? activeStage / 4 : processProgress, activeStage });
    updateHotspots();
  }
  const moving = motionEnabled && ((heroVisible && heroScene) || (processVisible && processScene));
  const settling = heroProgress !== targetHeroProgress || processProgress !== targetProcessProgress;
  if (moving || settling) schedule();
}

const preloader = document.querySelector('#preloader');
function finishPreloader() {
  if (preloader) preloader.hidden = true;
}
finishPreloader();
on(document.querySelector('#skip-preloader'), 'click', finishPreloader);

const menuToggle = document.querySelector('#menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');
function setMenu(open, restoreFocus = false) {
  menuToggle?.setAttribute('aria-expanded', String(open));
  menuToggle?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  header?.classList.toggle('menu-open', open);
  if (mobileNav) mobileNav.hidden = !open;
  if (!open && restoreFocus) menuToggle?.focus({ preventScroll: true });
}
on(menuToggle, 'click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
on(mobileNav, 'click', (event) => { if (event.target.closest('a')) setMenu(false); });
on(document, 'keydown', (event) => {
  if (event.key === 'Escape' && menuToggle?.getAttribute('aria-expanded') === 'true') setMenu(false, true);
});
on(document, 'pointerdown', (event) => {
  if (menuToggle?.getAttribute('aria-expanded') === 'true' && !header.contains(event.target)) setMenu(false);
});
on(document, 'focusin', (event) => {
  if (menuToggle?.getAttribute('aria-expanded') === 'true' && !header.contains(event.target)) setMenu(false);
});

on(document.querySelector('#motion-toggle'), 'click', () => {
  motionEnabled = !motionEnabled;
  storedMotion = motionEnabled ? 'on' : 'off';
  try { localStorage.setItem('groundwork-motion', storedMotion); } catch { /* Optional preference only. */ }
  applyMotion();
  createScenes();
  if (!motionEnabled) finishPreloader();
});
on(preference, 'change', () => {
  if (storedMotion === 'on' || storedMotion === 'off') return;
  motionEnabled = !preference.matches;
  applyMotion();
  createScenes();
});

stageButtons.forEach((button) => on(button, 'click', () => {
  const index = Number(button.dataset.stage);
  if (dirty) measure();
  const target = stageScrollTarget(processBounds.top, processBounds.height, window.innerHeight, index);
  stageOverride = { index, target, until: performance.now() + 1600, scrollY: window.scrollY };
  selectStage(index);
  if (processPinned) window.scrollTo({ top: target, behavior: motionEnabled ? 'smooth' : 'instant' });
  invalidate();
}));

on(window, 'scroll', () => {
  if (stageOverride && !processPinned && Math.abs(window.scrollY - stageOverride.scrollY) > 40) stageOverride = null;
  invalidate();
}, { passive: true });
on(window, 'wheel', () => { if (processPinned) stageOverride = null; }, { passive: true });
on(window, 'resize', () => {
  if (window.innerWidth > 900) setMenu(false);
  heroScene?.resize();
  processScene?.resize();
  invalidate();
}, { passive: true });
on(window, 'pointermove', (event) => {
  if (!motionEnabled || event.pointerType === 'touch' || !heroVisible) return;
  pointerX = (event.clientX / window.innerWidth - 0.5) * 2;
  pointerY = (event.clientY / window.innerHeight - 0.5) * 2;
  schedule();
}, { passive: true });
on(document, 'visibilitychange', () => {
  if (document.hidden) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  } else {
    previousTime = performance.now();
    invalidate();
  }
});

for (const [canvas, shell] of [[heroCanvas, heroShell], [processCanvas, processShell]]) {
  on(canvas, 'webglcontextlost', () => { shell.classList.remove('is-ready'); shell.classList.add('is-unavailable'); });
  on(canvas, 'webglcontextrestored', () => { shell.classList.remove('is-unavailable'); shell.classList.add('is-ready'); invalidate(); });
}

applyMotion();
cleanup.push(initProjects(), initServices(), initNewsletter({ endpoint: import.meta.env.VITE_NEWSLETTER_ENDPOINT || '' }));
const contact = document.querySelector('#contact-email');
if (contact) contact.href = `mailto:${safeContactEmail(import.meta.env.VITE_CONTACT_EMAIL)}`;
const year = document.querySelector('#copyright-year');
if (year) year.textContent = String(new Date().getFullYear());
const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(invalidate) : null;
resizeObserver?.observe(document.querySelector('#main'));
document.fonts?.ready.then(() => { if (!disposed) invalidate(); });
invalidate();
cleanup.push(deferDecorativeScenes(async () => {
  try {
    const [heroModule, processModule] = await Promise.all([
      import('./scene/hero-city.js'),
      import('./scene/process-stack.js'),
    ]);
    if (disposed) return;
    createHeroCity = heroModule.createHeroCity;
    createProcessStack = processModule.createProcessStack;
    createScenes();
  } catch {
    // Text, navigation and CSS architecture illustrations remain usable.
    if (!disposed) {
      heroShell?.classList.add('is-unavailable');
      processShell?.classList.add('is-unavailable');
    }
  }
}));

function dispose() {
  if (disposed) return;
  disposed = true;
  if (frame) cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  cleanup.forEach((remove) => remove());
  heroScene?.dispose();
  processScene?.dispose();
}

on(window, 'pagehide', (event) => { if (!event.persisted) dispose(); });
on(window, 'pageshow', () => { previousTime = performance.now(); invalidate(); });
if (import.meta.hot) import.meta.hot.dispose(dispose);
