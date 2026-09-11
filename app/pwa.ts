export type PwaState = {
  standalone: boolean;
  canInstall: boolean;
  showIosInstallHint: boolean;
  updateAvailable: boolean;
};

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Listener = (state: PwaState) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let state: PwaState = {
  standalone: false,
  canInstall: false,
  showIosInstallHint: false,
  updateAvailable: false,
};
const listeners = new Set<Listener>();

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function isIos() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function emit(partial: Partial<PwaState>) {
  state = { ...state, ...partial };
  for (const listener of listeners) listener(state);
}

function watchRegistration(nextRegistration: ServiceWorkerRegistration) {
  registration = nextRegistration;
  const watchWorker = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) emit({ updateAvailable: true });
    });
  };
  watchWorker(nextRegistration.installing);
  nextRegistration.addEventListener("updatefound", () => watchWorker(nextRegistration.installing));
  if (nextRegistration.waiting && navigator.serviceWorker.controller) emit({ updateAvailable: true });
}

export async function registerPwa() {
  if (typeof window === "undefined") return;
  emit({ standalone: isStandalone(), showIosInstallHint: isIos() && !isStandalone() });
  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => { deferredPrompt = null; emit({ canInstall: false, standalone: true }); });
  if ("serviceWorker" in navigator) {
    try {
      const nextRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      watchRegistration(nextRegistration);
      nextRegistration.update().catch(() => undefined);
    } catch {
      // PWA is progressive enhancement; the site remains fully usable without it.
    }
  }
}

export function subscribePwa(listener: Listener) {
  listeners.add(listener);
  listener(state);
  return () => { listeners.delete(listener); };
}

export async function installPwa() {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  emit({ canInstall: false });
  return choice.outcome === "accepted";
}

export function applyPwaUpdate() {
  if (!registration?.waiting) return false;
  const waiting = registration.waiting;
  const reload = () => window.location.reload();
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
