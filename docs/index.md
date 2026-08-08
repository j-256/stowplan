---
layout: home
title: Stowplan
hero:
  name: Stowplan
  text: Find what you packed without opening every box.
  tagline: Label spaces, capture what is inside, and get a practical plan for putting everything where it belongs. No account is needed to try it.
  actions:
    - theme: brand
      text: Try the kitchen demo
      link: stowplan:demo
    - theme: alt
      text: Organize your first room
      link: /guide/getting-started
features:
  - title: Start before the system is perfect
    details: Put a short code on each room, cabinet, drawer, box, or bin, then record what you see as you go.
  - title: Keep working without service
    details: Accepted changes are saved in this browser first. Keep counting in a basement, garage, or moving truck and back up later.
  - title: Find anything quickly
    details: Search names, descriptions, categories, tags, and locations across the workspace instead of opening containers one by one.
  - title: Make fewer physical moves
    details: Build an explainable move plan, review why each suggestion was made, and undo completed changes when reality differs.
---

The demo creates a ready-made kitchen workspace so you can capture an item, inspect a cabinet, search the inventory, and try a move plan without setting anything up. When you are ready to organize your own space, the [getting-started guide](/guide/getting-started) follows the same path with the labels you have on hand.

Stowplan works without an account. Signing in keeps the browser copy and can add an online server copy for backup and sharing. Authorized workspace members, installation administrators, and the host may be able to access that server copy. Read [Account, privacy, and data](/guide/account-data), the hosted service's [privacy policy](stowplan:privacy), and its [Terms of Service](stowplan:terms) before using online features.

Want to run Stowplan for a household, team, or community? Start with [Host and operate](/deploy/). Technical design, API, testing, and contributor material live under [Maintain](/maintainers/architecture).

## A look inside

Captured from the built-in kitchen demo.

<script setup>
import { withBase } from 'vitepress'
import { ref, onMounted } from 'vue'

const shots = [
  { src: withBase('/screenshots/capture.png'), mobile: withBase('/screenshots/capture-mobile.png'), caption: 'Capture: walk a container at a time, counting as you go.' },
  { src: withBase('/screenshots/plan.png'), mobile: withBase('/screenshots/plan-mobile.png'), caption: 'Plan: weighted priorities and an explainable move plan.' },
  { src: withBase('/screenshots/inventory.png'), mobile: withBase('/screenshots/inventory-mobile.png'), caption: 'Inventory: search every space at once, not box by box.' },
]

// Start on the middle slide so both neighbors show symmetrically on load.
const active = ref(1)
const len = shots.length

// Zoom gallery pages, bracketed with clones for the infinite loop:
// [cloneOfLast, ...shots, cloneOfFirst]. Clones are decorative duplicates.
const zoomPages = [
  { ...shots[len - 1], clone: true },
  ...shots.map((s) => ({ ...s })),
  { ...shots[0], clone: true },
]

// The slide transition is otherwise suppressed for visitors whose OS requests
// reduced motion (VitePress zeroes every transition-duration under that media
// query). ?animate opts back in -- an override for demoing the motion without
// changing an OS setting. Read after mount since the page is server-rendered.
const forceAnimate = ref(false)
onMounted(() => {
  forceAnimate.value = new URLSearchParams(window.location.search).has('animate')
})

// Signed offset of slide i from the active one on the shortest way round the
// loop: 0 = front, -1 = one to the left, +1 = one to the right, etc.
function offset(i) {
  let d = i - active.value
  if (d > len / 2) d -= len
  if (d < -len / 2) d += len
  return d
}

// Build the transform as a concrete string per slide. Driving it from a CSS
// custom property does NOT animate (transitions ignore unregistered custom
// properties), so the depth stack is computed here and the CSS transition on
// `transform` interpolates between these values.
function slideStyle(i) {
  const p = offset(i)
  const depth = Math.min(Math.abs(p), 1)
  return {
    transform: `translate(-50%, -50%) translateX(${p * 30}%) translateZ(${depth * -240}px) scale(${1 - depth * 0.18})`,
    opacity: 1 - depth * 0.35,
    filter: `brightness(${1 - depth * 0.4})`,
    // Active image (depth 0) sits above the click zones (z 2) and decorative
    // arrows (z 3); side slides (depth 1) sit below the zones so the zones own
    // their clicks. 4 when active, 1 otherwise.
    zIndex: depth === 0 ? 4 : 1,
  }
}
function go(dir) { active.value = (active.value + dir + len) % len }
function select(i) { if (i !== active.value) active.value = i }

// Carousel swipe via Pointer Events: one path for touch, mouse-drag, and pen.
// Deciding swipe-vs-tap here -- rather than on a trailing click -- avoids a
// misrouted click after the slide transition moves the target under the pointer.
const SWIPE_PX = 45
let startX = 0
let startY = 0
let startedOnActive = false // gesture began on the active image (-> tap zooms)
let tracking = false

// The active image lives inside the front (is-active) figure.
function isOnActiveImage(target) {
  return !!target.closest?.('.sp-cf-slide.is-active');
}
let captured = false
function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  startX = e.clientX
  startY = e.clientY
  startedOnActive = isOnActiveImage(e.target)
  tracking = true
  captured = false
  // NB: do NOT capture here. Capturing on pointerdown redirects the eventual
  // click to the stage, so a plain click on a zone button never reaches it.
  // Capture is deferred to the first real movement (onPointerMove).
}
function onPointerMove(e) {
  if (!tracking || captured) return
  // Once the pointer has clearly moved, it's a drag, not a click: capture so a
  // swipe that leaves/releases outside the stage still completes here.
  if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    captured = true
  }
}
function onPointerUp(e) {
  if (!tracking) return
  tracking = false
  const dx = e.clientX - startX
  const dy = e.clientY - startY
  // Horizontal drag past the threshold = swipe; vertical/short = tap.
  if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
    go(dx < 0 ? 1 : -1)
    return
  }
  // A short tap on the active image opens the zoom. (A plain click on a zone
  // button was never captured, so its own @click handler runs normally.)
  if (startedOnActive) openZoom()
}
// If the browser cancels the gesture (e.g. it decides to scroll), reset so the
// next gesture starts clean rather than inheriting a stuck tracking state.
function onPointerCancel() { tracking = false; captured = false }

// Full-screen zoom: a native <dialog> wrapping a horizontal scroll-snap gallery.
// Swiping is plain paged scroll (smooth and native, even under reduced motion),
// layered over the carousel. Opening scrolls instantly to the tapped slide.
const zoom = ref(null)
const zoomTrack = ref(null)
// The zoom track carries clones for a seamless loop: [cloneOfLast, 0..N-1,
// cloneOfFirst]. Real page i lives at track index i+1. Scrolling onto a clone
// (index 0 or N+1) jumps instantly to the identical real page, so the gallery
// wraps in both directions without a visible seam.
function trackTo(track, realIndex, animate) {
  track.style.scrollBehavior = animate ? '' : 'auto'
  track.scrollLeft = (realIndex + 1) * track.clientWidth
}
function openZoom() {
  const dlg = zoom.value
  if (!dlg) return
  dlg.showModal()
  const track = zoomTrack.value
  if (track) {
    trackTo(track, active.value, false)
    // Correct once layout settles (dialog just became visible).
    requestAnimationFrame(() => {
      trackTo(track, active.value, false)
      track.style.scrollBehavior = ''
    })
  }
}
function closeZoom() { zoom.value?.close() }
// Backdrop tap closes. Guard with a swallow so the click that lands on the
// carousel behind the dialog after it closes doesn't also advance it.
function onZoomClick(e) {
  if (e.target === zoom.value) { swallowNextClick(); closeZoom() }
}
function swallowNextClick() {
  const handler = (ev) => {
    ev.stopPropagation()
    ev.preventDefault()
    window.removeEventListener('click', handler, true)
  }
  window.addEventListener('click', handler, true)
  setTimeout(() => window.removeEventListener('click', handler, true), 400)
}
// Keep `active` in sync with the scrolled page (so closing returns to the last
// image viewed and the carousel/dots reflect it), and wrap seamlessly off the
// clones. The wrap-jump waits for the snap to settle so it doesn't interrupt an
// in-progress scroll.
let zoomSettle = null
function onZoomScroll(e) {
  const track = e.currentTarget
  if (!track.clientWidth) return
  const page = Math.round(track.scrollLeft / track.clientWidth) // 0..N+1 (incl clones)
  // Map the track page to a real index: page 0 is the last-image clone, page
  // N+1 is the first-image clone; real pages are 1..N.
  active.value = ((page - 1) % len + len) % len
  if (zoomSettle) clearTimeout(zoomSettle)
  zoomSettle = setTimeout(() => {
    if (page === 0 || page === len + 1) trackTo(track, active.value, false)
  }, 90)
}

// Left/right arrows navigate the carousel when it has focus. (The zoom gallery
// is scrolled, not keyed, but arrows still work there via the same handler.)
function onKeydown(e) {
  if (e.key === 'ArrowLeft') { go(-1); e.preventDefault() }
  else if (e.key === 'ArrowRight') { go(1); e.preventDefault() }
}
</script>

<div
  class="sp-cf"
  :class="{ 'sp-cf--animate': forceAnimate }"
  role="group"
  aria-roledescription="carousel"
  aria-label="App screenshots"
  tabindex="0"
  @keydown="onKeydown"
>
  <div class="sp-cf-stage" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel">
    <figure
      v-for="(shot, i) in shots"
      :key="shot.src"
      class="sp-cf-slide"
      :class="{ 'is-active': i === active }"
      :style="slideStyle(i)"
      :aria-hidden="i === active ? 'false' : 'true'"
    >
      <img :src="shot.mobile" :alt="shot.caption" draggable="false" loading="lazy" />
    </figure>
    <!-- Large invisible click targets: the left/right thirds of the stage
         advance the carousel (for discrete clicks; drags are handled as swipes
         at the stage level). They sit above the tucked-back side slides but
         below the active image, so the centre stays inert. -->
    <button class="sp-cf-zone sp-cf-zone-prev" @click="go(-1)" aria-label="Previous screenshot"></button>
    <button class="sp-cf-zone sp-cf-zone-next" @click="go(1)" aria-label="Next screenshot"></button>
    <span class="sp-cf-nav sp-cf-prev" aria-hidden="true">&#8249;</span>
    <span class="sp-cf-nav sp-cf-next" aria-hidden="true">&#8250;</span>
  </div>
  <p class="sp-cf-caption">{{ shots[active].caption }}</p>
  <div class="sp-cf-dots" role="tablist">
    <button
      v-for="(shot, i) in shots"
      :key="shot.src"
      class="sp-cf-dot"
      :class="{ 'is-active': i === active }"
      @click="select(i)"
      :aria-label="`Show screenshot ${i + 1}`"
      :aria-selected="i === active"
    ></button>
  </div>

  <dialog ref="zoom" class="sp-cf-zoom" @click="onZoomClick">
    <button class="sp-cf-zoom-close" @click="closeZoom" aria-label="Close full-screen view">&times;</button>
    <!-- Horizontal scroll-snap gallery: swipe = native paged scroll. The list is
         [cloneOfLast, ...shots, cloneOfFirst]; landing on a clone jumps to the
         matching real page for a seamless infinite loop. Scrolling updates
         `active` so closing returns to the last-viewed image. -->
    <div class="sp-cf-zoom-track" ref="zoomTrack" @scroll.passive="onZoomScroll">
      <figure v-for="(shot, i) in zoomPages" :key="i" class="sp-cf-zoom-page" :aria-hidden="shot.clone ? 'true' : null">
        <img :src="shot.mobile" :alt="shot.clone ? '' : shot.caption" draggable="false" />
      </figure>
    </div>
  </dialog>
</div>

<section class="sp-desktop" aria-label="The same views on a desktop">
  <p class="sp-desktop-label">On a bigger screen</p>
  <figure v-for="shot in shots" :key="shot.src" class="sp-desktop-shot">
    <img :src="shot.src" :alt="shot.caption" loading="lazy" />
  </figure>
</section>

<style>
/* Namespaced under .sp-cf: a <style> block in a VitePress markdown page is global. */
.sp-cf{
  position:relative;
  margin:32px calc(50% - 50vw) 8px;
  padding:44px 0 28px;
  background:#000;
  overflow:hidden;
  display:grid;
  justify-items:center;
}
/* Focusable for arrow-key nav; show a ring only for keyboard focus, inset so it
   isn't clipped by overflow:hidden. */
.sp-cf:focus{ outline:none; }
.sp-cf:focus-visible{ outline:2px solid var(--vp-c-brand-1, #536954); outline-offset:-2px; }
.sp-cf-stage{
  position:relative;
  width:100%;
  /* The carousel always shows the portrait mobile screenshots -- the mobile UI
     is the headline on every device. The images are portrait (390x900, aspect
     ~0.43). The active image is width-driven (height:auto), so its height =
     width / 0.43. Capping the active width at 260px caps the height, which the
     stage below always clears, so the image can't overflow (clipping its top or
     bleeding over the dots). Below ~419px the 62% term wins, so narrow phones
     still fill the stage. The click zones track the same variable. */
  height:min(150vw, 640px);
  perspective:1600px;
  transform-style:preserve-3d;
  /* Let the browser own vertical panning (page scroll) but hand horizontal
     gestures to the swipe handler. Without this, a touch drag is claimed by
     native scrolling and fires pointercancel, so the swipe never completes. */
  touch-action:pan-y;
  /* Active image width; the click zones fill exactly the gap on either side of
     it, so no zone ever overlaps the active image. */
  --sp-active-w:min(62%, 260px);
}
.sp-cf-slide{
  position:absolute;
  top:50%;
  left:50%;
  margin:0;
  width:var(--sp-active-w);
  /* The click zones own advancing, so slides don't take pointer events; this
     also stops a side image from swallowing a zone click at its near edge. */
  pointer-events:none;
  /* transform/opacity/filter/z-index are set inline per slide (see slideStyle);
     the depth stack has to be concrete values for this transition to animate. */
  transition:transform .5s cubic-bezier(.22,.61,.36,1), opacity .5s, filter .5s;
}
/* The active slide (above the zones at z 4) takes clicks again so tapping it
   opens the full-screen zoom; side slides stay inert so the zones advance. */
.sp-cf-slide.is-active{ pointer-events:auto; cursor:zoom-in; }
/* ?animate re-enables the slide transition even under prefers-reduced-motion,
   whose global reset forces transition-duration:0s !important. This class
   selector outweighs that universal-selector rule, so the motion returns. */
.sp-cf--animate .sp-cf-slide{ transition-duration:.5s, .5s, .5s !important; }
.sp-cf-slide picture{ display:block; }
.sp-cf-slide img{
  width:100%;
  height:auto;
  display:block;
  border-radius:12px;
  box-shadow:0 24px 60px rgba(0,0,0,.6);
  -webkit-user-drag:none;
  user-select:none;
}
/* Large invisible click zones: each fills the full-height gap between a stage
   edge and the active image (half of whatever the active image does not cover),
   so the zones reach right up to the active image but never overlap it. They sit
   above the tucked-back side slides (z 1) and below the active image (z 4). */
.sp-cf-zone{
  position:absolute;
  top:0;bottom:0;
  z-index:2;
  width:calc((100% - var(--sp-active-w)) / 2);
  border:0;
  background:transparent;
  padding:0;
  cursor:pointer;
}
.sp-cf-zone-prev{ left:0; }
.sp-cf-zone-next{ right:0; }
/* Decorative chevrons -- purely visual (the zones handle clicks). They brighten
   when the zone under them is hovered. */
.sp-cf-nav{
  position:absolute;
  top:50%;
  transform:translateY(-50%);
  z-index:3;
  width:44px;height:44px;
  display:grid;place-items:center;
  border-radius:50%;
  background:rgba(255,255,255,.1);
  color:#fff;font-size:24px;line-height:1;
  pointer-events:none;
  transition:background .2s;
}
.sp-cf-prev{ left:16px; }
.sp-cf-next{ right:16px; }
.sp-cf-zone-prev:hover ~ .sp-cf-prev,
.sp-cf-zone-next:hover ~ .sp-cf-next{ background:rgba(255,255,255,.26); }
.sp-cf-caption{
  margin:22px 0 0;
  color:rgba(255,255,255,.72);
  font-size:14px;
  text-align:center;
}
.sp-cf-dots{ display:flex; gap:9px; margin-top:14px; }
.sp-cf-dot{
  width:8px;height:8px;padding:0;border:0;border-radius:50%;
  background:rgba(255,255,255,.28);cursor:pointer;transition:background .2s,transform .2s;
}
.sp-cf-dot.is-active{ background:#fff; transform:scale(1.3); }
/* Full-screen zoom: a native <dialog> (Escape + ::backdrop free) holding a
   horizontal scroll-snap gallery, so swiping is plain native paged scroll. */
.sp-cf-zoom{
  border:0;
  padding:0;
  background:transparent;
  max-width:100vw;
  max-height:100vh;
  width:100vw;
  height:100dvh;
  margin:0;
}
/* Closed <dialog> is display:none by default; only lay it out when open, so it
   doesn't cover the page on load. */
.sp-cf-zoom[open]{ display:block; }
.sp-cf-zoom::backdrop{ background:rgba(0,0,0,.9); }
.sp-cf-zoom-track{
  display:flex;
  width:100%;
  height:100%;
  overflow-x:auto;
  overflow-y:hidden;
  scroll-snap-type:x mandatory;
  scrollbar-width:none;
  -webkit-overflow-scrolling:touch;
}
.sp-cf-zoom-track::-webkit-scrollbar{ display:none; }
.sp-cf-zoom-page{
  flex:0 0 100%;
  scroll-snap-align:center;
  scroll-snap-stop:always;
  margin:0;
  display:grid;
  place-items:center;
  padding:16px;
  box-sizing:border-box;
}
.sp-cf-zoom-page picture{ display:block; }
.sp-cf-zoom-page img{
  display:block;
  max-width:96vw;
  max-height:92dvh;
  width:auto;
  height:auto;
  border-radius:8px;
  box-shadow:0 30px 80px rgba(0,0,0,.7);
  -webkit-user-drag:none;
  user-select:none;
}
.sp-cf-zoom-close{
  position:fixed;
  top:16px;right:16px;
  width:44px;height:44px;
  display:grid;place-items:center;
  border:0;border-radius:50%;
  background:rgba(255,255,255,.14);
  color:#fff;font-size:26px;line-height:1;
  cursor:pointer;
  transition:background .2s;
}
.sp-cf-zoom-close:hover{ background:rgba(255,255,255,.28); }

/* Secondary desktop strip below the mobile carousel. The carousel headlines the
   phone UI on every device; these show the same views on a wider screen. Capped
   near the VitePress content width so the landscape shots stay large and legible
   rather than shrinking to thumbnails. */
.sp-desktop{
  margin:8px auto 0;
  max-width:760px;
  display:grid;
  gap:20px;
  justify-items:center;
}
.sp-desktop-label{
  margin:0;
  text-transform:uppercase;
  letter-spacing:.08em;
  font-size:13px;
  font-weight:700;
  color:var(--vp-c-text-2);
}
.sp-desktop-shot{ margin:0; width:100%; }
.sp-desktop-shot img{
  width:100%;
  height:auto;
  display:block;
  border-radius:12px;
  border:1px solid var(--vp-c-divider);
  box-shadow:0 12px 30px rgba(0,0,0,.28);
}
</style>
