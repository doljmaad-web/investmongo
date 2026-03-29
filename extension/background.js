// Service worker — keeps extension alive
chrome.runtime.onInstalled.addListener(() => {
  console.log('INVEST MONGO extension installed');
});
