const input    = document.getElementById('botUrl');
const saveBtn  = document.getElementById('saveBtn');
const savedMsg = document.getElementById('savedMsg');
const dashLink = document.getElementById('dashLink');

// Load saved URL on open
chrome.storage.sync.get({ botUrl: '' }, ({ botUrl }) => {
  input.value = botUrl;
  updateDashLink(botUrl);
});

saveBtn.addEventListener('click', () => {
  const url = input.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ botUrl: url }, () => {
    savedMsg.style.display = 'block';
    setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
    updateDashLink(url);
  });
});

function updateDashLink(url) {
  if (url) {
    dashLink.href = url;
    dashLink.style.display = 'block';
  } else {
    dashLink.style.display = 'none';
  }
}
