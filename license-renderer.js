const { ipcRenderer } = require('electron');

const keyInput = document.getElementById('licenseKey');
const verifyBtn = document.getElementById('verifyBtn');
const statusDiv = document.getElementById('status-message');

// Format input with dashes
keyInput.addEventListener('input', (e) => {
    let val = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    e.target.value = val;
});

verifyBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();

    if (!key) {
        showStatus('Please enter a key', 'error');
        return;
    }

    setLoading(true);

    // Send key to main process (don't wait for response)
    ipcRenderer.send('validate-license-async', key);
});

// Listen for validation result (errors)
ipcRenderer.on('license-validation-result', (event, result) => {
    console.log('🔴 Got validation result:', result);
    if (!result.valid) {
        showStatus(result.message || 'Invalid License', 'error');
        setLoading(false);
    }
});

function showStatus(msg, type) {
    statusDiv.textContent = msg;
    statusDiv.className = 'status ' + type;
}

function setLoading(isLoading) {
    verifyBtn.disabled = isLoading;
    if (isLoading) {
        verifyBtn.innerHTML = '<div class="loading-spinner"></div> Verifying...';
    } else {
        verifyBtn.textContent = 'Activate';
    }
}

// Settings Logic
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const urlInput = document.getElementById('server-url-input');

if (btnSettings) {
    btnSettings.addEventListener('click', async () => {
        const currentUrl = await ipcRenderer.invoke('get-server-url');
        urlInput.value = currentUrl;
        settingsModal.style.display = 'block';
    });

    btnCloseSettings.addEventListener('click', () => {
        settingsModal.style.display = 'none';
    });

    btnSaveSettings.addEventListener('click', async () => {
        const newUrl = urlInput.value.trim();
        if (!newUrl) return;

        const res = await ipcRenderer.invoke('update-server-url', newUrl);
        if (res.success) {
            settingsModal.style.display = 'none';
            showStatus('Server URL updated. Retrying...', 'success');
        } else {
            alert('Error: ' + res.error);
        }
    });
}
