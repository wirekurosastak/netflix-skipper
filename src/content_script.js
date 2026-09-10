const INTRO_UIA = "player-skip-intro";
const RECAP_UIA = "player-skip-recap";
const NEXT_UIA = "next-episode-seamless-button";
const NEXT_DRAIN_UIA = "next-episode-seamless-button-draining";
const CREDITS_UIA = "watch-credits-seamless-button";

const BUTTONS = [INTRO_UIA, RECAP_UIA, NEXT_UIA, NEXT_DRAIN_UIA, CREDITS_UIA];

// Selectors for the Netflix "Are you still watching?" inactivity prompt
const STILL_WATCHING_SELECTORS = [
  "[data-uia='interrupt-autoplay-continue']",
  "[data-uia='continue-watching']",
  "[data-uia='player-autoplay-interrupter-continue']",
  ".interrupter-actions button",
  "button.watch-video--continue-button",
];

// Helper to check if extension context is still active (handles reload in developer mode)
function isExtensionValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
}

// In-memory settings cache (avoids repeated asynchronous storage queries)
let settings = {
  skipIntro: true,
  skipRecap: true,
  skipNext: true,
  noSkipFirst: false,
  skipStillWatching: true,
  exemptTitles: [],
};

// Initialize settings from storage
if (isExtensionValid()) {
  chrome.storage.local.get(
    ["skipIntro", "skipRecap", "skipNext", "noSkipFirst", "skipStillWatching", "exemptTitles"],
    (result) => {
      if (chrome.runtime?.lastError) return;
      if (result) {
        settings = { ...settings, ...result };
      }
    }
  );

  // Reactively keep settings in sync when changed via popup
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      for (const key of Object.keys(changes)) {
        if (key in settings) {
          settings[key] = changes[key].newValue;
        }
      }
    }
  });
}

// Function to extract the current Netflix title
function getCurrentTitle() {
  const titleElement = document.querySelector("[data-uia='video-title']");

  if (titleElement) {
    const h4Element = titleElement.querySelector("h4");
    if (h4Element && h4Element.textContent.trim()) {
      return h4Element.textContent.trim();
    }

    if (titleElement.textContent.trim()) {
      return titleElement.textContent.trim();
    }
  }

  const pageTitle = document.title;
  if (pageTitle && pageTitle !== "Netflix" && !pageTitle.includes("Watch ")) {
    return pageTitle.replace(" - Netflix", "").trim();
  }

  return null;
}

// Function that checks if the episode is the first one
function isCurrentFirstEpisode() {
  const titleElement = document.querySelector("[data-uia='video-title']");
  if (titleElement) {
    const spanElement = titleElement.querySelector("span");
    if (spanElement && spanElement.textContent) {
      const text = spanElement.textContent.trim();
      return /(?:^|[\s:S])(?:E|Ep\.?|Episode|T\d+:E)?\s*1(?:\D|$)/i.test(text);
    }
  }
  return false;
}

let observer = null;
let fallbackInterval = null;

function skipper() {
  // Gracefully exit and clean up if extension was reloaded or updated
  if (!isExtensionValid()) {
    if (observer) observer.disconnect();
    if (fallbackInterval) clearInterval(fallbackInterval);
    return;
  }

  try {
    // 1. Dismiss "Are you still watching?" prompt if enabled
    if (settings.skipStillWatching) {
      for (const selector of STILL_WATCHING_SELECTORS) {
        const stillWatchingBtn = document.querySelector(selector);
        if (stillWatchingBtn) {
          stillWatchingBtn.click();
          break;
        }
      }
    }

    // 2. Check if current title is in exempt list
    const currentTitle = getCurrentTitle();
    const isExempt = currentTitle && settings.exemptTitles.includes(currentTitle);
    if (isExempt) {
      return;
    }

    // 3. Check first episode status
    const isFirstEpisode = settings.noSkipFirst ? isCurrentFirstEpisode() : false;

    // 4. Check and click skip buttons
    const mapper = {
      [INTRO_UIA]: settings.skipIntro && !isFirstEpisode,
      [RECAP_UIA]: settings.skipRecap,
      [NEXT_UIA]: settings.skipNext && !isFirstEpisode,
      [NEXT_DRAIN_UIA]: settings.skipNext && !isFirstEpisode,
      [CREDITS_UIA]: !settings.skipNext || isFirstEpisode,
    };

    for (const uia of BUTTONS) {
      if (mapper[uia]) {
        const button = document.querySelector(`button[data-uia="${uia}"]`);
        if (button) {
          button.click();
        }
      }
    }
  } catch (err) {
    if (err?.message?.includes("Extension context invalidated")) {
      return;
    }
    console.error("Netflix Skipper error:", err);
  }
}

// Function to add/remove current title from exempt list
async function toggleExemptStatus() {
  if (!isExtensionValid()) return;
  const currentTitle = getCurrentTitle();
  if (!currentTitle) {
    console.log("Netflix Skipper: Could not detect current title");
    return;
  }

  try {
    const result = await chrome.storage.local.get(["exemptTitles"]);
    const exemptTitles = result.exemptTitles || [];

    let updatedTitles;
    if (exemptTitles.includes(currentTitle)) {
      updatedTitles = exemptTitles.filter((title) => title !== currentTitle);
      console.log(`Netflix Skipper: Removed "${currentTitle}" from exempt list`);
    } else {
      updatedTitles = [...exemptTitles, currentTitle];
      console.log(`Netflix Skipper: Added "${currentTitle}" to exempt list`);
    }

    settings.exemptTitles = updatedTitles;
    await chrome.storage.local.set({ exemptTitles: updatedTitles });
  } catch (err) {
    if (err?.message?.includes("Extension context invalidated")) return;
    console.error("Netflix Skipper: Error toggling exempt status:", err);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isExtensionValid()) return;
  if (request.action === "toggleExempt") {
    toggleExemptStatus();
    sendResponse({ success: true });
  } else if (request.action === "getCurrentTitle") {
    const title = getCurrentTitle();
    sendResponse({ title });
  }
});

// Setup MutationObserver and fallback runner on Netflix pages
if (document.location.host.includes(".netflix.")) {
  let isScheduled = false;

  // Debounced runner using requestAnimationFrame for 0ms visual delay and 0% idle CPU
  const scheduleSkipper = () => {
    if (!isExtensionValid()) {
      if (observer) observer.disconnect();
      if (fallbackInterval) clearInterval(fallbackInterval);
      return;
    }
    if (!isScheduled) {
      isScheduled = true;
      requestAnimationFrame(() => {
        skipper();
        isScheduled = false;
      });
    }
  };

  observer = new MutationObserver(() => {
    scheduleSkipper();
  });

  const startObserver = () => {
    const target = document.body || document.documentElement;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
      scheduleSkipper();
    } else {
      setTimeout(startObserver, 100);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }

  // Low-frequency safety fallback (every 2.5s) to guarantee check during silent state changes
  fallbackInterval = setInterval(() => skipper(), 2500);
}
