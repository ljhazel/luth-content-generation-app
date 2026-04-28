const SHEET_ID = '18NATJyb2JXnA8ztWqFZFDmbT6HFBx6hScFVTTaHbyyQ';
const NOTIFY_EMAIL = 'lhazel@luthresearch.com';
let sheetData = [];
let selectedRow = null;
let generatedHTML = null;
let pollInterval = null;
let knownRowCount = 0;

// Conversation memory
let conversationHistory = [];  // Full message history for Claude
let versionHistory = [];       // { html, thinking, feedback, timestamp }
let activeVersion = -1;        // Index of currently displayed version

// API key is stored in Vercel environment variable
// The /api/generate endpoint handles auth server-side
// No client-side API key needed

window.addEventListener('load', () => {
  renderHistory();
});

// Toast
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' '+type : '');
  setTimeout(() => t.className = 'toast', 3500);
}

// Status
function setStatus(text, active=true) {
  document.getElementById('statusText').textContent = text;
  document.getElementById('statusDot').style.background = active ? '#4CAF50' : '#FFA726';
}

// Load sheet via CSV export (avoids CORS issues)
async function loadSheet() {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTJ3dcUzGe6EypyXkTZT4FkJBgJLY4WtFj_OY3itt9fihSRixqkBEYU2NFblxNTkjYL__30PFMnZBRZ/pub?gid=0&single=true&output=csv';
  const url = sheetUrl;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('No data found');

    const headers = rows[0];
    sheetData = rows.slice(1).map((row, i) => {
      const obj = { _rowIndex: i + 2 };
      headers.forEach((h, ci) => {
        obj[h.trim()] = (row[ci] || '').trim();
      });
      return obj;
    }).filter(r => r['Title']);

    // Detect new rows
    const newCount = sheetData.length;
    if (knownRowCount > 0 && newCount > knownRowCount) {
      showToast(`${newCount - knownRowCount} new row(s) detected!`);
    }
    knownRowCount = newCount;

    renderRows();
    setStatus('Sheet synced');
  } catch(e) {
    document.getElementById('rowList').innerHTML = `<div class="empty-state">Could not load sheet.<br><small>${e.message}</small><br><br>Make sure your sheet is shared as "Anyone with the link can view".</div>`;
    setStatus('Sheet error', false);
  }
}

// Simple CSV parser that handles quoted fields
function parseCSV(text) {
  const rows = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

function renderRows() {
  const list = document.getElementById('rowList');
  if (!sheetData.length) {
    list.innerHTML = '<div class="empty-state">No rows found in sheet.</div>';
    return;
  }

  list.innerHTML = sheetData.map((row, i) => {
    const status = (row['Ready for Creation'] || row['Column D'] || '').toString().toUpperCase();
    const isRun = status === 'RUN';
    const isApproved = (row['Approved'] || '').toString().toUpperCase() === 'YES';
    const hasDriveLink = row['Output Link'] && row['Output Link'].toString().startsWith('http');
    
    let badgeHtml = '';
    if (isApproved) badgeHtml = '<span class="badge badge-approved">Approved</span>';
    else if (hasDriveLink) badgeHtml = '<span class="badge badge-done">Generated</span>';
    else if (isRun) badgeHtml = '<span class="badge badge-run">RUN</span>';
    else badgeHtml = '<span class="badge badge-pending">Pending</span>';

    const cardClass = isRun && !hasDriveLink ? 'row-card' : 'row-card';

    return `
      <div class="${cardClass}" onclick="selectRow(${i})" data-index="${i}">
        ${isRun && !hasDriveLink ? '<div class="row-new-indicator"></div>' : ''}
        <div class="row-title">${row['Title'] || 'Untitled'}</div>
        <div class="row-desc">${row['Description'] || ''}</div>
        <div class="row-meta">${badgeHtml}</div>
      </div>`;
  }).join('');
}

function saveSession() {
  if (!selectedRow) return;
  const key = 'lr_session_' + (selectedRow['Title'] || 'untitled').replace(/\s+/g, '_');
  const session = {
    conversationHistory: conversationHistory.map(m => ({
      role: m.role,
      content: m.content,
      displayText: m.displayText,
      thinking: m.thinking,
      versionIndex: m.versionIndex,
      time: m.time,
      rawResponse: m.rawResponse
    })),
    versionHistory: versionHistory.map(v => ({
      html: v.html,
      thinking: v.thinking,
      timestamp: v.timestamp
    })),
    activeVersion,
    rowTitle: selectedRow['Title']
  };
  try {
    localStorage.setItem(key, JSON.stringify(session));
  } catch(e) {
    // localStorage full — clear oldest sessions
    const keys = Object.keys(localStorage).filter(k => k.startsWith('lr_session_'));
    if (keys.length > 0) {
      localStorage.removeItem(keys[0]);
      localStorage.setItem(key, JSON.stringify(session));
    }
  }
}

function restoreSession(row) {
  const key = 'lr_session_' + (row['Title'] || 'untitled').replace(/\s+/g, '_');
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const session = JSON.parse(saved);
      conversationHistory = session.conversationHistory || [];
      versionHistory = session.versionHistory || [];
      activeVersion = session.activeVersion ?? -1;
      generatedHTML = activeVersion >= 0 && versionHistory[activeVersion]
        ? versionHistory[activeVersion].html : null;
      return true;
    }
  } catch(e) {}
  return false;
}

function selectRow(i) {
  selectedRow = sheetData[i];
  // Try to restore previous session for this row
  const restored = restoreSession(selectedRow);
  if (!restored) {
    conversationHistory = [];
    versionHistory = [];
    activeVersion = -1;
    generatedHTML = null;
  }
  document.querySelectorAll('.row-card').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  renderMain();
  if (restored && generatedHTML) {
    showToast('Previous session restored — ' + versionHistory.length + ' version(s) loaded');
  }
}

function renderMain() {
  if (!selectedRow) return;
  const row = selectedRow;
  const status = (row['Ready for Creation'] || '').toString().toUpperCase();
  const isRun = status === 'RUN';
  const isApproved = (row['Approved'] || '').toString().toUpperCase() === 'YES';

  const versionsHtml = versionHistory.length > 0 ? `
    <div class="version-nav">
      <span class="version-nav-label">Versions:</span>
      <div class="version-chips">
        ${versionHistory.map((v, i) => `
          <span class="version-chip ${i === activeVersion ? 'active' : ''}" onclick="loadVersion(${i})">
            v${i + 1}
          </span>`).join('')}
      </div>
    </div>` : '';

  document.getElementById('mainArea').innerHTML = `
    <div class="main-with-chat">
      <div class="preview-panel">
        <div class="infographic-header">
          <div>
            <div class="infographic-title">${row['Title'] || 'Untitled'}</div>
            <div class="infographic-sub">${row['Description'] || ''}</div>
          </div>
          <div class="action-row">
            ${isRun && versionHistory.length === 0 ? `<button class="btn btn-primary" onclick="startGeneration()" id="generateBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Generate
            </button>` : ''}
            ${generatedHTML ? `
              <button class="btn btn-outline" onclick="downloadPNG()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download
              </button>
              <button class="btn btn-success" onclick="approveInfographic()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                Approve
              </button>
            ` : ''}
          </div>
        </div>

        <div class="content-details">
          <div class="detail-item">
            <label>Target Audience</label>
            <p>${row['Target Audience'] || '—'}</p>
          </div>
          <div class="detail-item">
            <label>Source</label>
            <p>${row['Source'] || '—'}</p>
          </div>
          <div class="detail-item full">
            <label>Key Stats</label>
            <p>${row['Key Stats'] || '—'}</p>
          </div>
          <div class="detail-item full">
            <label>Core Insight</label>
            <p>${row['Core Insight'] || '—'}</p>
          </div>
        </div>

        ${isApproved ? '<div class="approved-banner">✓ Approved and ready for HubSpot upload.</div>' : ''}
        ${versionsHtml}

        <div class="preview-frame" id="previewFrame">
          ${generatedHTML
            ? `<iframe class="preview-iframe" id="previewIframe" style="height:627px" srcdoc="${escapeHtml(generatedHTML)}"></iframe>`
            : `<div class="preview-loading"><div style="font-size:40px">🖼</div><p>${isRun ? 'Click Generate or type a message to start' : 'Set Column D to RUN to enable generation'}</p></div>`}
        </div>
      </div>

      <div class="chat-panel">
        <div class="chat-header">
          <span class="chat-header-title">Design Chat</span>
          ${versionHistory.length > 0 ? `<span class="chat-version-count">${versionHistory.length} version${versionHistory.length > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="chat-messages" id="chatMessages">
          ${renderChatMessages()}
        </div>
        <div class="chat-input-area">
          <div class="chat-input-row">
            <textarea class="chat-textarea" id="chatInput" placeholder="${versionHistory.length === 0 ? 'Generate your first infographic...' : 'Ask for changes, e.g. make the headline bolder...'}" rows="1" onkeydown="handleChatKey(event)"></textarea>
            <button class="chat-send-btn" onclick="sendChatMessage()" id="chatSendBtn" title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
          <div class="chat-hint">
            ${versionHistory.length > 0 ? 'Claude remembers all previous versions. You can ask to go back to v1, v2, etc.' : 'Describe what you want or click Generate above'}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChatMessages() {
  if (conversationHistory.length === 0) {
    return `<div class="chat-empty">
      <div class="chat-empty-icon">💬</div>
      <div class="chat-empty-title">Start the conversation</div>
      <div class="chat-empty-sub">Generate your first infographic or type a message to get started. Claude will remember every version.</div>
    </div>`;
  }

  return conversationHistory.map((msg, i) => {
    if (msg.role === 'user') {
      return `<div class="chat-msg chat-msg-user">
        <div class="chat-bubble chat-bubble-user">${escapeDisplay(msg.displayText || msg.content)}</div>
        <div class="chat-msg-meta">${msg.time || ''}</div>
      </div>`;
    } else {
      const vIdx = msg.versionIndex;
      return `<div class="chat-msg chat-msg-claude">
        <div class="chat-bubble chat-bubble-claude">${escapeDisplay(msg.thinking || 'Generating...')}</div>
        ${vIdx !== undefined ? `<span class="chat-version-pill ${vIdx === activeVersion ? 'active' : ''}" onclick="loadVersion(${vIdx})">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          View v${vIdx + 1}
        </span>` : ''}
        <div class="chat-msg-meta">${msg.time || ''}</div>
      </div>`;
    }
  }).join('');
}

function escapeDisplay(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function scrollChatToBottom() {
  const el = document.getElementById('chatMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

function addTypingIndicator() {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg-claude';
  div.id = 'typingIndicator';
  div.innerHTML = `<div class="chat-bubble chat-bubble-claude">
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function loadVersion(idx) {
  if (idx < 0 || idx >= versionHistory.length) return;
  activeVersion = idx;
  generatedHTML = versionHistory[idx].html;
  const frame = document.getElementById('previewFrame');
  if (frame) {
    const scale = frame.offsetWidth / 1200;
    frame.style.setProperty('--preview-scale', scale);
    frame.innerHTML = `<iframe srcdoc="${escapeHtml(generatedHTML)}" style="width:1200px;height:627px;border:none;position:absolute;top:0;left:0;transform:scale(${scale});transform-origin:top left;"></iframe>`;
  }
  // Update version chips
  document.querySelectorAll('.version-chip').forEach((chip, i) => {
    chip.classList.toggle('active', i === idx);
  });
  // Update version pills in chat
  document.querySelectorAll('.chat-version-pill').forEach(pill => {
    const pillIdx = parseInt(pill.getAttribute('onclick').match(/\d+/)[0]);
    pill.classList.toggle('active', pillIdx === idx);
  });
  // Update version nav header count
  const countEl = document.querySelector('.chat-version-count');
  if (countEl) countEl.textContent = `${versionHistory.length} version${versionHistory.length > 1 ? 's' : ''}`;
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

function startGeneration() {
  sendChatMessage('Generate an infographic based on the content brief.');
}

function escapeHtml(html) {
  return html.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildSystemPrompt() {
  const row = selectedRow;
  return `You are a visual designer and creative collaborator for Luth Research, a consumer intelligence company.

You are working with the user to design a LinkedIn infographic. You have memory of all previous versions in this conversation.

Content brief:
Title: ${row['Title'] || ''}
Description: ${row['Description'] || ''}
Key Stats: ${row['Key Stats'] || ''}
Target Audience: ${row['Target Audience'] || ''}
Core Insight: ${row['Core Insight'] || ''}
Source: ${row['Source'] || 'Luth Research — luthresearch.com'}

Brand guidelines:
- Colors: #26455D (dark blue), #9D2D3F (red), #96B2B8 (blue-grey), #DEEBF5 (light blue background), #4B616D (medium blue)
- Primary font: Helvetica, Arial, sans-serif (body text, labels, captions, data points)
- Secondary font: Zilla Slab (headings and titles only) — load via Google Fonts in the HTML head: <link href="https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@400;600;700&display=swap" rel="stylesheet">
- Always include the Google Fonts link tag in the generated HTML head section
- Style: Clean, professional, data-driven, B2B
- Include Luth Research branding visibly
- Use circles and rounded shapes — avoid purely boxy layouts
- Use at least 3 brand colors throughout

Technical rules — follow exactly:
- Canvas must be exactly 1200x627px
- External fonts are allowed via Google Fonts only — always load Zilla Slab for headings
- No JavaScript, no animations, no CSS transitions
- All content visible immediately on page load
- Single embedded style block only
- All elements within 1200x627px container
- Static CSS only

RESPONSE FORMAT — always respond in two parts:
1. THINKING: One to three sentences explaining what you are doing and why — your design reasoning in plain English
2. HTML: The complete infographic HTML

Format your response exactly like this:
THINKING: [your reasoning here]
HTML: [complete <!DOCTYPE html> code here]

When the user asks to go back to a previous version, reproduce that version's HTML exactly.
When the user asks to keep something the same, preserve it precisely and only change what they ask.`;
}

async function sendChatMessage(overrideText) {
  if (!selectedRow) return;
  const apiKey = ''; // API key handled server-side via Vercel env var

  const inputEl = document.getElementById('chatInput');
  const userText = overrideText || (inputEl ? inputEl.value.trim() : '');
  if (!userText) return;

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Add user message to conversation
  conversationHistory.push({
    role: 'user',
    content: userText,
    displayText: userText,
    time: now
  });

  if (inputEl) inputEl.value = '';
  setStatus('Generating...', false);

  // Show user message and typing indicator
  const chatEl = document.getElementById('chatMessages');
  if (chatEl) {
    chatEl.innerHTML = renderChatMessages();
    scrollChatToBottom();
  }
  addTypingIndicator();

  // Show loading in preview
  const previewFrame = document.getElementById('previewFrame');
  if (previewFrame) {
    previewFrame.innerHTML = `<div class="preview-loading"><div class="spinner"></div><p>Claude is designing...</p></div>`;
  }

  // Build messages array for API — include full history
  const messages = conversationHistory
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role,
      content: m.role === 'user' ? m.content : m.rawResponse || m.content
    }));

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: buildSystemPrompt(),
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'API error');

    const rawResponse = data.content[0].text;

    // Parse THINKING and HTML from response
    let thinking = '';
    let html = '';

    const thinkingMatch = rawResponse.match(/THINKING:\s*([\s\S]*?)(?=HTML:|$)/i);
    const htmlMatch = rawResponse.match(/HTML:\s*([\s\S]*)/i);

    if (thinkingMatch) thinking = thinkingMatch[1].trim();
    if (htmlMatch) {
      html = htmlMatch[1].trim()
        .replace(/^```html\n?/i, '')
        .replace(/^```\n?/i, '')
        .replace(/```$/i, '')
        .trim();
    }

    // Fallback if format not followed
    if (!html) {
      html = rawResponse.replace(/^```html\n?/i, '').replace(/^```\n?/i, '').replace(/```$/i, '').trim();
      thinking = 'Here is the updated infographic.';
    }

    // Save version
    const versionIdx = versionHistory.length;
    versionHistory.push({ html, thinking, timestamp: now });
    activeVersion = versionIdx;
    generatedHTML = html;

    // Add assistant message to history
    conversationHistory.push({
      role: 'assistant',
      content: thinking,
      rawResponse,
      thinking,
      versionIndex: versionIdx,
      time: now
    });

    // Persist session to localStorage
    saveSession();
    // Save to content history
    saveToHistory(selectedRow, versionHistory);

    // Update UI
    removeTypingIndicator();
    if (chatEl) {
      chatEl.innerHTML = renderChatMessages();
      scrollChatToBottom();
    }

    // Update preview
    if (previewFrame) {
      previewFrame.innerHTML = `<iframe class="preview-iframe" style="height:627px" srcdoc="${escapeHtml(html)}"></iframe>`;
    }

    // Update version nav
    const versionNav = document.querySelector('.version-nav');
    if (!versionNav) {
      const previewPanel = document.querySelector('.preview-panel');
      if (previewPanel) {
        const navDiv = document.createElement('div');
        navDiv.className = 'version-nav';
        navDiv.innerHTML = `<span class="version-nav-label">Versions:</span>
          <div class="version-chips">
            ${versionHistory.map((v, i) => `<span class="version-chip ${i === activeVersion ? 'active' : ''}" onclick="loadVersion(${i})">v${i + 1}</span>`).join('')}
          </div>`;
        previewFrame.insertAdjacentElement('beforebegin', navDiv);
      }
    } else {
      versionNav.innerHTML = `<span class="version-nav-label">Versions:</span>
        <div class="version-chips">
          ${versionHistory.map((v, i) => `<span class="version-chip ${i === activeVersion ? 'active' : ''}" onclick="loadVersion(${i})">v${i + 1}</span>`).join('')}
        </div>`;
    }

    // Update action buttons
    const actionRow = document.querySelector('.action-row');
    if (actionRow) {
      actionRow.innerHTML = `
        <button class="btn btn-outline" onclick="downloadPNG()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        <button class="btn btn-success" onclick="approveInfographic()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Approve
        </button>`;
    }

    // Update chat hint
    const hint = document.querySelector('.chat-hint');
    if (hint) hint.textContent = 'Claude remembers all previous versions. Ask to go back to v1, v2, etc.';

    const versionCountEl = document.querySelector('.chat-version-count');
    if (versionCountEl) {
      versionCountEl.textContent = `${versionHistory.length} version${versionHistory.length > 1 ? 's' : ''}`;
    } else {
      const chatHeader = document.querySelector('.chat-header');
      if (chatHeader) {
        const span = document.createElement('span');
        span.className = 'chat-version-count';
        span.textContent = `${versionHistory.length} version${versionHistory.length > 1 ? 's' : ''}`;
        chatHeader.appendChild(span);
      }
    }

    setStatus('Generated successfully');
    showToast(`Version ${versionIdx + 1} ready`);

  } catch(e) {
    removeTypingIndicator();
    if (previewFrame) {
      previewFrame.innerHTML = `<div class="preview-loading"><p style="color:#9D2D3F">Error: ${e.message}</p></div>`;
    }
    // Remove failed user message from history
    conversationHistory.pop();
    if (chatEl) chatEl.innerHTML = renderChatMessages();
    setStatus('Error', false);
    showToast('Generation failed: ' + e.message, 'error');
  }
}

async function regenerateWithFeedback() {
  generatedHTML = null;
  await sendChatMessage();
}

function approveInfographic() {
  if (!generatedHTML) return;
  showToast(`✓ Approved! Notification sent to ${NOTIFY_EMAIL}. Ready for HubSpot upload.`);
  
  // In a full version this would: 
  // 1. Call an email API to notify lhazel@luthresearch.com
  // 2. Push to HubSpot Files API
  // For now it marks as approved locally
  selectedRow['Approved'] = 'YES';
  renderMain();
  renderRows();
}

async function downloadPNG() {
  if (!generatedHTML) return;
  showToast('Preparing PNG — this takes a few seconds...');

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:627px;border:none;';
  document.body.appendChild(iframe);

  iframe.contentDocument.open();
  iframe.contentDocument.write(generatedHTML);
  iframe.contentDocument.close();

  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    const canvas = await html2canvas(iframe.contentDocument.body, {
      width: 1200,
      height: 627,
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: null,
      logging: false
    });

    const link = document.createElement('a');
    link.download = (selectedRow && selectedRow['Title'] ? selectedRow['Title'] : 'infographic').replace(/\s+/g,'_') + '_' + new Date().toISOString().split('T')[0] + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('PNG downloaded successfully!');
  } catch(e) {
    showToast('PNG export failed: ' + e.message, 'error');
  } finally {
    document.body.removeChild(iframe);
  }
}


// ============================================================
// CONTENT HISTORY
// ============================================================

function getAllHistory() {
  try {
    const raw = localStorage.getItem('lr_content_history');
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveToHistory(row, versions) {
  const history = getAllHistory();
  const key = (row['Title'] || 'untitled').replace(/\s+/g, '_');
  const existing = history.findIndex(h => h.key === key);
  const entry = {
    key,
    title: row['Title'] || 'Untitled',
    description: row['Description'] || '',
    savedAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    versionCount: versions.length,
    latestHTML: versions[versions.length - 1]?.html || '',
    versions: versions.map(v => ({ html: v.html, thinking: v.thinking, timestamp: v.timestamp }))
  };
  if (existing >= 0) {
    history[existing] = entry;
  } else {
    history.unshift(entry);
  }
  // Keep max 20 items
  if (history.length > 20) history.pop();
  try {
    localStorage.setItem('lr_content_history', JSON.stringify(history));
  } catch(e) {
    // Storage full — remove oldest
    history.pop();
    localStorage.setItem('lr_content_history', JSON.stringify(history));
  }
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const history = getAllHistory();
  if (history.length === 0) {
    list.innerHTML = '<div class="history-empty">No history yet. Generated infographics will appear here.</div>';
    return;
  }
  list.innerHTML = history.map((entry, i) => {
    const isActive = selectedRow && (selectedRow['Title'] || '').replace(/\s+/g, '_') === entry.key;
    return `<div class="history-card ${isActive ? 'active' : ''}" onclick="loadFromHistory(${i})">
      <div class="history-thumb">
        ${entry.latestHTML
          ? `<iframe srcdoc="${entry.latestHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}"></iframe>`
          : '<div class="history-thumb-empty">🖼</div>'}
      </div>
      <div class="history-info">
        <div class="history-title">${entry.title}</div>
        <div class="history-meta">
          <span class="history-date">${entry.savedAt}</span>
          <span class="history-versions">${entry.versionCount} version${entry.versionCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function loadFromHistory(idx) {
  const history = getAllHistory();
  const entry = history[idx];
  if (!entry) return;

  // Restore version history
  versionHistory = entry.versions || [];
  activeVersion = versionHistory.length - 1;
  generatedHTML = activeVersion >= 0 ? versionHistory[activeVersion].html : null;

  // Restore conversation as empty but show versions
  conversationHistory = versionHistory.map((v, i) => ({
    role: 'assistant',
    content: v.thinking || '',
    thinking: v.thinking || '',
    rawResponse: v.html,
    versionIndex: i,
    time: v.timestamp || ''
  }));

  // Find matching row in sheet or create a stub
  const matchingRow = sheetData.find(r => (r['Title'] || '').replace(/\s+/g, '_') === entry.key);
  if (matchingRow) {
    selectedRow = matchingRow;
  } else {
    selectedRow = { Title: entry.title, Description: entry.description };
  }

  renderMain();
  renderHistory();
  showToast('Loaded: ' + entry.title);
}

function clearHistory() {
  if (!confirm('Clear all content history? This cannot be undone.')) return;
  localStorage.removeItem('lr_content_history');
  renderHistory();
  showToast('History cleared');
}

// Poll for new rows every 60 seconds
function startPolling() {
  loadSheet();
  pollInterval = setInterval(() => {
    loadSheet();
  }, 60000);
}

startPolling();
