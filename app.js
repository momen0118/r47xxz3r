/* ============================
   燈 — Chat Client Logic
   ============================ */

(() => {
  'use strict';

  // ── Storage Keys ──
  const SK = {
    API_KEY:   'aki_apikey',
    MODEL:     'aki_model',
    SYSTEM:    'aki_system',
    KNOWLEDGE: 'aki_knowledge',
    THREADS:   'aki_threads',
    ACTIVE:    'aki_active',
    MAX_TOK:   'aki_maxtok',
  };

  // ── State ──
  let threads   = [];
  let activeId  = null;
  let streaming = false;
  let abortCtrl = null;

  // ── Mobile detection ──
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
                   ('ontouchstart' in window);

  // ── DOM ──
  const $ = id => document.getElementById(id);
  const overlay         = $('overlay');
  const sidebar         = $('sidebar');
  const threadList      = $('threadList');
  const menuBtn         = $('menuBtn');
  const newThreadBtn    = $('newThreadBtn');
  const chatMessages    = $('chatMessages');
  const emptyState      = $('emptyState');
  const messageInput    = $('messageInput');
  const sendBtn         = $('sendBtn');
  const topbarTitle     = $('topbarTitle');
  const settingsOverlay = $('settingsOverlay');
  const apiKeyInput     = $('apiKeyInput');
  const modelSelect     = $('modelSelect');
  const systemPrompt    = $('systemPromptInput');
  const knowledgeInput  = $('knowledgeInput');
  const maxTokensInput  = $('maxTokensInput');
  const renameOverlay   = $('renameOverlay');
  const renameInput     = $('renameInput');

  // ── Init ──
  function init() {
    loadState();
    cleanEmptyThreads();
    renderThreadList();
    if (activeId && threads.find(t => t.id === activeId)) {
      switchThread(activeId);
    } else if (threads.length) {
      switchThread(threads[0].id);
    } else {
      renderMessages();
    }
    bindEvents();
    autoResize(messageInput);
  }

  // ── Persistence ──
  function loadState() {
    apiKeyInput.value    = localStorage.getItem(SK.API_KEY) || '';
    modelSelect.value    = localStorage.getItem(SK.MODEL)   || 'claude-opus-4-6';
    systemPrompt.value   = localStorage.getItem(SK.SYSTEM)  || '';
    knowledgeInput.value = localStorage.getItem(SK.KNOWLEDGE) || '';
    maxTokensInput.value = localStorage.getItem(SK.MAX_TOK) || '8192';
    try { threads = JSON.parse(localStorage.getItem(SK.THREADS)) || []; } catch { threads = []; }
    activeId = localStorage.getItem(SK.ACTIVE) || null;
  }

  function saveThreads() {
    localStorage.setItem(SK.THREADS, JSON.stringify(threads));
    localStorage.setItem(SK.ACTIVE,  activeId || '');
  }

  function saveSettings() {
    localStorage.setItem(SK.API_KEY,    apiKeyInput.value.trim());
    localStorage.setItem(SK.MODEL,      modelSelect.value);
    localStorage.setItem(SK.SYSTEM,     systemPrompt.value);
    localStorage.setItem(SK.KNOWLEDGE,  knowledgeInput.value);
    localStorage.setItem(SK.MAX_TOK,    maxTokensInput.value);
  }

  // ── Thread CRUD ──
  function createThread(name) {
    cleanEmptyThreads();
    const t = {
      id: 't_' + Date.now(),
      name: name || '新しいスレッド',
      messages: [],
      created: Date.now(),
    };
    threads.unshift(t);
    saveThreads();
    renderThreadList();
    switchThread(t.id);
    return t;
  }

  function deleteThread(id) {
    threads = threads.filter(t => t.id !== id);
    if (activeId === id) {
      activeId = threads.length ? threads[0].id : null;
    }
    saveThreads();
    renderThreadList();
    if (activeId) switchThread(activeId);
    else renderMessages();
  }

  function renameThread(id, name) {
    const t = threads.find(t => t.id === id);
    if (t) { t.name = name; saveThreads(); renderThreadList(); updateTopbar(); }
  }

  function cleanEmptyThreads() {
    const before = threads.length;
    threads = threads.filter(t => t.messages.length > 0);
    if (threads.length !== before) {
      if (activeId && !threads.find(t => t.id === activeId)) {
        activeId = threads.length ? threads[0].id : null;
      }
      saveThreads();
    }
  }

  function getActive() { return threads.find(t => t.id === activeId) || null; }

  function switchThread(id) {
    if (activeId && activeId !== id) {
      const prev = threads.find(t => t.id === activeId);
      if (prev && prev.messages.length === 0) {
        threads = threads.filter(t => t.id !== activeId);
      }
    }
    activeId = id;
    saveThreads();
    renderThreadList();
    renderMessages();
    updateTopbar();
    closeSidebar();
  }

  // ── Render ──
  function renderThreadList() {
    threadList.innerHTML = '';
    threads.forEach(t => {
      if (t.messages.length === 0 && t.id !== activeId) return;
      const el = document.createElement('div');
      el.className = 'thread-item' + (t.id === activeId ? ' active' : '');
      el.innerHTML = `
        <span class="thread-item-name">${esc(t.name)}</span>
        <div class="thread-item-actions">
          <button class="thread-action-btn rename-btn" data-id="${t.id}" title="名前変更">✎</button>
          <button class="thread-action-btn danger delete-btn" data-id="${t.id}" title="削除">✕</button>
        </div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.thread-action-btn')) return;
        switchThread(t.id);
      });
      threadList.appendChild(el);
    });

    threadList.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRename(btn.dataset.id);
      });
    });
    threadList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('このスレッドを削除する？')) deleteThread(btn.dataset.id);
      });
    });
  }

  function renderMessages() {
    const t = getActive();
    chatMessages.innerHTML = '';
    if (!t || t.messages.length === 0) {
      chatMessages.appendChild(emptyState);
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    t.messages.forEach(m => {
      chatMessages.appendChild(createMsgEl(m.role, m.content));
    });
    scrollToBottom();
  }

  function createMsgEl(role, content) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const label = role === 'user' ? 'you' : '燈';
    el.innerHTML = `<div class="msg-role">${label}</div><div class="msg-content"></div>`;
    el.querySelector('.msg-content').textContent = content;
    return el;
  }

  function updateTopbar() {
    const t = getActive();
    topbarTitle.textContent = t ? t.name : '燈';
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // ── Build system prompt ──
  function buildSystemPrompt() {
    const sys  = localStorage.getItem(SK.SYSTEM) || '';
    const know = localStorage.getItem(SK.KNOWLEDGE) || '';
    const parts = [];
    if (sys.trim())  parts.push(sys.trim());
    if (know.trim()) parts.push('<knowledge>\n' + know.trim() + '\n</knowledge>');
    return parts.join('\n\n');
  }

  // ── API Call (Streaming) ──
  async function sendMessage(text) {
    if (streaming) return;
    const apiKey = localStorage.getItem(SK.API_KEY);
    if (!apiKey) { showToast('APIキーを設定してください'); openSettings(); return; }

    let t = getActive();
    if (!t) t = createThread();

    t.messages.push({ role: 'user', content: text });
    saveThreads();

    emptyState.style.display = 'none';
    if (emptyState.parentNode === chatMessages) {
      chatMessages.removeChild(emptyState);
    }

    chatMessages.appendChild(createMsgEl('user', text));
    scrollToBottom();

    if (t.messages.length === 1 && t.name === '新しいスレッド') {
      const preview = text.slice(0, 20) + (text.length > 20 ? '…' : '');
      renameThread(t.id, preview);
    }

    const apiMessages = t.messages.map(m => ({ role: m.role, content: m.content }));

    const asstEl = document.createElement('div');
    asstEl.className = 'msg assistant streaming';
    asstEl.innerHTML = `<div class="msg-role">燈</div><div class="msg-content"></div>`;
    chatMessages.appendChild(asstEl);
    const contentEl = asstEl.querySelector('.msg-content');
    scrollToBottom();

    streaming = true;
    sendBtn.disabled = true;
    abortCtrl = new AbortController();
    let fullResponse = '';

    try {
      const model    = localStorage.getItem(SK.MODEL) || 'claude-opus-4-6';
      const maxTok   = parseInt(localStorage.getItem(SK.MAX_TOK)) || 8192;
      const sysPrompt = buildSystemPrompt();

      const body = {
        model,
        max_tokens: maxTok,
        stream: true,
        messages: apiMessages,
      };
      if (sysPrompt) body.system = sysPrompt;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `API Error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullResponse += evt.delta.text;
              contentEl.textContent = fullResponse;
              scrollToBottom();
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // cancelled
      } else {
        showToast(err.message);
        if (!fullResponse) asstEl.remove();
      }
    } finally {
      streaming = false;
      abortCtrl = null;
      asstEl.classList.remove('streaming');
      updateSendBtn();

      if (fullResponse) {
        t.messages.push({ role: 'assistant', content: fullResponse });
        saveThreads();
      }
    }
  }

  // ── UI Events ──
  function bindEvents() {
    menuBtn.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', closeSidebar);
    newThreadBtn.addEventListener('click', () => createThread());

    $('openSettingsBtn').addEventListener('click', openSettings);
    $('topbarSettingsBtn').addEventListener('click', openSettings);
    $('closeSettingsBtn').addEventListener('click', closeSettings);
    $('saveSettingsBtn').addEventListener('click', () => { saveSettings(); closeSettings(); });
    settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

    $('toggleKeyVis').addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });

    $('closeRenameBtn').addEventListener('click', closeRename);
    renameOverlay.addEventListener('click', (e) => { if (e.target === renameOverlay) closeRename(); });

    // Send — mobile: Enter = newline only, desktop: Enter = send
    sendBtn.addEventListener('click', handleSend);
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        if (isMobile) return; // let Enter insert newline
        if (!e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      }
    });
    messageInput.addEventListener('input', updateSendBtn);
    messageInput.addEventListener('compositionend', updateSendBtn);
  }

  function handleSend() {
    const text = messageInput.value.trim();
    if (!text || streaming) return;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    updateSendBtn();
    sendMessage(text);
  }

  function updateSendBtn() {
    sendBtn.disabled = !messageInput.value.trim() || streaming;
  }

  function toggleSidebar() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }

  function openSettings() {
    closeSidebar();
    apiKeyInput.value    = localStorage.getItem(SK.API_KEY) || '';
    modelSelect.value    = localStorage.getItem(SK.MODEL)   || 'claude-opus-4-6';
    systemPrompt.value   = localStorage.getItem(SK.SYSTEM)  || '';
    knowledgeInput.value = localStorage.getItem(SK.KNOWLEDGE) || '';
    maxTokensInput.value = localStorage.getItem(SK.MAX_TOK) || '8192';
    settingsOverlay.classList.add('open');
  }

  function closeSettings() {
    settingsOverlay.classList.remove('open');
  }

  let renamingId = null;
  function openRename(id) {
    renamingId = id;
    const t = threads.find(t => t.id === id);
    renameInput.value = t ? t.name : '';
    renameOverlay.classList.add('open');
    setTimeout(() => renameInput.focus(), 100);

    $('saveRenameBtn').onclick = () => {
      const name = renameInput.value.trim();
      if (name && renamingId) renameThread(renamingId, name);
      closeRename();
    };
    renameInput.onkeydown = (e) => {
      if (e.key === 'Enter') $('saveRenameBtn').click();
    };
  }

  function closeRename() {
    renameOverlay.classList.remove('open');
    renamingId = null;
  }

  // ── Toast ──
  let toastEl = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  // ── Auto Resize Textarea ──
  function autoResize(el) {
    el.addEventListener('input', () => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    });
  }

  // ── Util ──
  function esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Start ──
  init();
})();
