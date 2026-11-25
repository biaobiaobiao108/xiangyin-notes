export type PwaState = {
  standalone: boolean;
  canInstall: boolean;
  showIosInstallHint: boolean;
};

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Listener = (state: PwaState) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let state: PwaState = {
  standalone: false,
  canInstall: false,
  showIosInstallHint: false,
};
const listeners = new Set<Listener>();

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function isIos() {
  return (
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function emit(partial: Partial<PwaState>) {
  state = { ...state, ...partial };
  for (const listener of listeners) listener(state);
}

async function removeLegacyServiceWorker() {
  const serviceWorkers = navigator.serviceWorker;
  const scriptUrl = new URL("/sw.js", location.origin).href;
  const registration = await serviceWorkers?.getRegistration("/");
  const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
  if (registration && worker?.scriptURL === scriptUrl) {
    await registration.unregister();
  }
  // A controlled page keeps using the old worker until it navigates away.
  if (typeof caches === "undefined" || serviceWorkers?.controller?.scriptURL === scriptUrl) return;
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith("xiangying-notes-shell-")).map((key) => caches.delete(key)),
  );
}

export function initializePwa() {
  if (typeof window === "undefined") return;
  emit({ standalone: isStandalone(), showIosInstallHint: isIos() && !isStandalone() });
  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emit({ canInstall: false, standalone: true });
  });
  void removeLegacyServiceWorker().catch((error: unknown) => {
    console.warn("无法清理旧版象映笔记的离线缓存", error);
  });
}

export function subscribePwa(listener: Listener) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export async function installPwa() {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  emit({ canInstall: false });
  return choice.outcome === "accepted";
}
