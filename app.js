/* ============================
   燈 — Chat Client Logic v2
   ============================ */

(() => {
  'use strict';

  const SK = {
    API_KEY:   'aki_apikey',
    MODEL:     'aki_model',
    SYSTEM:    'aki_system',
    KNOWLEDGE: 'aki_knowledge',
    THREADS:   'aki_threads',
    ACTIVE:    'aki_active',
    MAX_TOK:   'aki_maxtok',
  };

  let threads   = [];
  let activeId  = null;
  let streaming = false;
  let abortCtrl = null;
  let pendingImages = []; // [{data, mediaType, thumbnail}]

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
                   ('ontouchstart' in window);

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
  const imageInput      = $('imageInput');
  const attachBtn       = $('attachBtn');
  const attachPreview   = $('attachPreview');

  // ── Image processing ──
  const MAX_IMG_DIM = 800;
  const IMG_QUALITY = 0.8;

  function resizeAndCompress(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;

          // Only resize if larger than max
          if (width > MAX_IMG_DIM || height > MAX_IMG_DIM) {
            if (width > height) {
              height = Math.round(height * MAX_IMG_DIM / width);
              width = MAX_IMG_DIM;
            } else {
              width = Math.round(width * MAX_IMG_DIM / height);
              height = MAX_IMG_DIM;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Full size for API (stored in memory only during session)
          const fullDataUrl = canvas.toDataURL('image/jpeg', IMG_QUALITY);
          const fullBase64 = fullDataUrl.split(',')[1];

          // Thumbnail for storage/display
          const thumbSize = 120;
          let tw = thumbSize, th = thumbSize;
          if (width > height) { th = Math.round(height * thumbSize / width); }
          else { tw = Math.round(width * thumbSize / height); }
          const tc = document.createElement('canvas');
          tc.width = tw; tc.height = th;
          tc.getContext('2d').drawImage(img, 0, 0, tw, th);
          const thumbDataUrl = tc.toDataURL('image/jpeg', 0.6);

          resolve({
            data: fullBase64,
            mediaType: 'image/jpeg',
            thumbnail: thumbDataUrl,
          });
        };
        img.onerror = () => reject(new Error('画像を読み込めませんでした'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
      reader.readAsDataURL(file);
    });
  }

  function renderAttachPreview() {
    attachPreview.innerHTML = '';
    pendingImages.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'attach-thumb';
      thumb.innerHTML = `
        <img src="${img.thumbnail}" alt="">
        <div class="attach-thumb-remove" data-idx="${i}">✕</div>
      `;
      attachPreview.appendChild(thumb);
    });
    attachPreview.querySelectorAll('.attach-thumb-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingImages.splice(parseInt(btn.dataset.idx), 1);
        renderAttachPreview();
        updateSendBtn();
      });
    });
  }

  // ── Init ──
  function init() {
    try {
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
    } catch (e) {
      console.error('Init error:', e);
      document.body.insertAdjacentHTML('afterbegin',
        `<div style="position:fixed;top:0;left:0;right:0;padding:12px;background:#a04040;color:#fff;font-size:13px;z-index:9999">${e.message}</div>`
      );
    }
  }

  function loadState() {
    if (apiKeyInput)    apiKeyInput.value    = localStorage.getItem(SK.API_KEY) || '';
    if (modelSelect)    modelSelect.value    = localStorage.getItem(SK.MODEL)   || 'claude-opus-4-6';
    if (systemPrompt)   systemPrompt.value   = localStorage.getItem(SK.SYSTEM)  || '';
    if (knowledgeInput) knowledgeInput.value  = localStorage.getItem(SK.KNOWLEDGE) || '';
    if (maxTokensInput) maxTokensInput.value  = localStorage.getItem(SK.MAX_TOK) || '8192';
    try { threads = JSON.parse(localStorage.getItem(SK.THREADS)) || []; } catch { threads = []; }
    activeId = localStorage.getItem(SK.ACTIVE) || null;
  }

  function saveThreads() {
    try {
      localStorage.setItem(SK.THREADS, JSON.stringify(threads));
      localStorage.setItem(SK.ACTIVE,  activeId || '');
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        showToast('ストレージ容量が不足しています。古いスレッドを削除してください');
      }
    }
  }

  function saveSettings() {
    localStorage.setItem(SK.API_KEY,    (apiKeyInput    && apiKeyInput.value    || '').trim());
    localStorage.setItem(SK.MODEL,      (modelSelect    && modelSelect.value    || 'claude-opus-4-6'));
    localStorage.setItem(SK.SYSTEM,     (systemPrompt   && systemPrompt.value   || ''));
    localStorage.setItem(SK.KNOWLEDGE,  (knowledgeInput && knowledgeInput.value || ''));
    localStorage.setItem(SK.MAX_TOK,    (maxTokensInput && maxTokensInput.value || '8192'));
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
    pendingImages = [];
    renderAttachPreview();
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
      chatMessages.appendChild(createMsgEl(m.role, m.text || m.content, m.images));
    });
    scrollToBottom();
  }

  function createMsgEl(role, content, images) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const label = role === 'user' ? 'you' : '燈';

    let imagesHtml = '';
    if (images && images.length > 0) {
      imagesHtml = '<div class="msg-images">' +
        images.map(img => `<img src="${img.thumbnail || img}" alt="">`).join('') +
        '</div>';
    }

    el.innerHTML = `<div class="msg-role">${label}</div>${imagesHtml}<div class="msg-content"></div>`;
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

  function buildSystemPrompt() {
    const sys  = localStorage.getItem(SK.SYSTEM) || '';
    const know = localStorage.getItem(SK.KNOWLEDGE) || '';
    const parts = [];
    if (sys.trim())  parts.push(sys.trim());
    if (know.trim()) parts.push('<knowledge>\n' + know.trim() + '\n</knowledge>');
    return parts.join('\n\n');
  }

  // ── Build API message content ──
  function buildUserContent(text, images) {
    // If no images, simple string
    if (!images || images.length === 0) return text;

    // With images, use content array
    const content = [];
    images.forEach(img => {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data,
        }
      });
    });
    if (text) {
      content.push({ type: 'text', text });
    }
    return content;
  }

  // ── Build full API messages array ──
  function buildApiMessages(messages) {
    return messages.map(m => {
      if (m.role === 'user' && m.apiImages && m.apiImages.length > 0) {
        return { role: 'user', content: buildUserContent(m.text || m.content, m.apiImages) };
      }
      return { role: m.role, content: m.text || m.content };
    });
  }

  // ── API Call ──
  async function sendMessage(text, images) {
    if (streaming) return;
    const apiKey = localStorage.getItem(SK.API_KEY);
    if (!apiKey) { showToast('APIキーを設定してください'); openSettings(); return; }

    let t = getActive();
    if (!t) t = createThread();

    // Store message — thumbnails for localStorage, full data in memory for API
    const msgObj = {
      role: 'user',
      text: text,
      content: text, // fallback
      images: images ? images.map(i => ({ thumbnail: i.thumbnail })) : [],
      apiImages: images || [], // full base64, not persisted (too large)
    };
    t.messages.push(msgObj);
    saveThreads();

    emptyState.style.display = 'none';
    if (emptyState.parentNode === chatMessages) {
      chatMessages.removeChild(emptyState);
    }

    chatMessages.appendChild(createMsgEl('user', text, msgObj.images));
    scrollToBottom();

    if (t.messages.length === 1 && t.name === '新しいスレッド') {
      const preview = text.slice(0, 20) + (text.length > 20 ? '…' : '');
      renameThread(t.id, preview);
    }

    const apiMessages = buildApiMessages(t.messages);

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
        t.messages.push({ role: 'assistant', text: fullResponse, content: fullResponse });
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

    // Image attach
    attachBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', async () => {
      const files = Array.from(imageInput.files);
      if (!files.length) return;
      for (const file of files) {
        try {
          const processed = await resizeAndCompress(file);
          pendingImages.push(processed);
        } catch (e) {
          showToast(e.message);
        }
      }
      renderAttachPreview();
      updateSendBtn();
      imageInput.value = '';
    });

    // Send
    sendBtn.addEventListener('click', handleSend);
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        if (isMobile) return;
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
    const images = pendingImages.length > 0 ? [...pendingImages] : null;
    if (!text && !images) return;
    if (streaming) return;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    pendingImages = [];
    renderAttachPreview();
    updateSendBtn();
    sendMessage(text, images);
  }

  function updateSendBtn() {
    sendBtn.disabled = (!messageInput.value.trim() && pendingImages.length === 0) || streaming;
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
    if (apiKeyInput)    apiKeyInput.value    = localStorage.getItem(SK.API_KEY) || '';
    if (modelSelect)    modelSelect.value    = localStorage.getItem(SK.MODEL)   || 'claude-opus-4-6';
    if (systemPrompt)   systemPrompt.value   = localStorage.getItem(SK.SYSTEM)  || '';
    if (knowledgeInput) knowledgeInput.value  = localStorage.getItem(SK.KNOWLEDGE) || '';
    if (maxTokensInput) maxTokensInput.value  = localStorage.getItem(SK.MAX_TOK) || '8192';
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

  function autoResize(el) {
    el.addEventListener('input', () => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    });
  }

  function esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  init();
})();
