// Full screen on phones and tablets: the browser's address bar and buttons take
// a big bite out of a landscape phone screen. Browsers only allow going full
// screen right after a tap, so the first tap on the game does it (and locks the
// screen sideways where the phone allows). iPhones can't do this from a web
// page: there the game goes full screen when added to the home screen
// (manifest.webmanifest + the apple-mobile-web-app meta tags in index.html).

const KEY = 'sciboom.fullscreen';

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

const doc = document as FsDocument;

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Opened from the home screen icon (already without the browser's bars) */
function isStandalone(): boolean {
  return matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Whether this browser lets a web page go full screen (iPhone Safari doesn't) */
export function canFullscreen(): boolean {
  return !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** The player's choice; phones and tablets start with it on */
export function autoFullscreen(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch {
    // ignore
  }
  return isTouchDevice();
}

export function setAutoFullscreen(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // ignore
  }
  if (on) enterFullscreen();
  else exitFullscreen();
}

/** Must be called from a tap/click (browsers refuse otherwise) */
export function enterFullscreen() {
  if (isFullscreen() || !canFullscreen()) return;
  const el = document.documentElement as FsElement;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : (el.webkitRequestFullscreen?.(), undefined);
    Promise.resolve(p)
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => {}); // refused, or the phone can't lock: the "rotate your phone" hint still helps
  } catch {
    // ignore
  }
}

export function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  } catch {
    // ignore
  }
}

/**
 * Go full screen on the first tap (and again on a later tap if the player left
 * it with the back button), unless they switched it off in the settings.
 */
export function setupAutoFullscreen() {
  if (isStandalone()) return;
  const onTap = (e: PointerEvent) => {
    // Not while typing in a text box: the phone keyboard would fight with the switch
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (autoFullscreen()) enterFullscreen();
  };
  // pointerup counts as a tap that browsers accept for full screen
  window.addEventListener('pointerup', onTap, { capture: true });
}
