/* ============================
   ⊹ — Chat Client Logic v5
   Encrypted localStorage
   + Fable 5 / thinking表示 / 停止ボタン / usage表示
   ============================ */

(() => {
  'use strict';

  const SK = {
    API_KEY:   'aki_apikey',
    MODEL:     'aki_model',
    SYSTEM:    'aki_system',
    KNOWLEDGE: 'aki_knowledge',
    KNOW_ON:   'aki_know_on',
    THREADS:   'aki_threads',
    ACTIVE:    'aki_active',
    MAX_TOK:   'aki_maxtok',
    PRESETS:   'aki_presets',
    EFFORT:    'aki_effort',
  };

  // Effort → budget_tokens マッピング（none = thinking 無効）
  const EFFORT_MAP = {
    none:   0,
    low:    2048,
    medium: 8192,
    high:   16384,
  };

  let threads   = [];
  let activeId  = null;
  let streaming = false;
  let abortCtrl = null;
  let pendingImages = [];

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
                   ('ontouchstart' in window);

  const $ = id => document.getElementById(id);

  // DOM refs (set after unlock)
  let overlay, sidebar, threadList, menuBtn, newThreadBtn, chatMessages, emptyState;
  let messageInput, sendBtn, topbarTitle, settingsOverlay, apiKeyInput, modelSelect;
  let systemPrompt, knowledgeInput, knowledgeToggle, maxTokensInput, effortSelect;
  let renameOverlay, renameInput, imageInput, attachBtn, attachPreview;
  let presetSelect, presetSaveBtn, presetDelBtn;
  let presets = [];

  // Lock screen refs
  const lockScreen   = $('lockScreen');
  const lockPassInput = $('lockPassInput');
  const lockUnlockBtn = $('lockUnlockBtn');
  const lockHint      = $('lockHint');

  // ══════════════════════════════════
  // Lock Screen
  // ══════════════════════════════════

  function initLockScreen() {
    const isFirstTime = !AkiCrypto.isSetup();

    if (isFirstTime) {
      lockPassInput.placeholder = 'パスワードを設定';
      lockUnlockBtn.textContent = '設定';
    } else {
      lockPassInput.placeholder = 'パスワード';
      lockUnlockBtn.textContent = '開く';
    }

    lockUnlockBtn.addEventListener('click', handleUnlock);
    lockPassInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleUnlock();
    });

    lockPassInput.focus();
  }

  async function handleUnlock() {
    const pw = lockPassInput.value;
    if (!pw) { lockHint.textContent = 'パスワードを入力してください'; return; }

    lockUnlockBtn.disabled = true;
    lockHint.textContent = '';

    try {
      if (!AkiCrypto.isSetup()) {
        // First time setup
        if (pw.length < 4) {
          lockHint.textContent = '4文字以上で設定してください';
          lockUnlockBtn.disabled = false;
          return;
        }

        // Read existing unencrypted data before setup
        const oldData = {};
        for (const key of Object.values(SK)) {
          const val = localStorage.getItem(key);
          if (val !== null) oldData[key] = val;
        }

        await AkiCrypto.setup(pw);

        // Migrate: re-encrypt old data, or set defaults
        for (const key of Object.values(SK)) {
          if (oldData[key] !== undefined) {
            await AkiCrypto.secureSet(key, oldData[key]);
          }
        }
        // Ensure defaults for keys that didn't exist
        if (!oldData[SK.MODEL])    await AkiCrypto.secureSet(SK.MODEL, 'claude-fable-5');
        if (!oldData[SK.MAX_TOK])  await AkiCrypto.secureSet(SK.MAX_TOK, '8192');
        if (!oldData[SK.KNOW_ON])  await AkiCrypto.secureSet(SK.KNOW_ON, '1');
        if (!oldData[SK.THREADS])  await AkiCrypto.secureSet(SK.THREADS, '[]');
        if (!oldData[SK.PRESETS])  await AkiCrypto.secureSet(SK.PRESETS, '[]');
        if (!oldData[SK.EFFORT])   await AkiCrypto.secureSet(SK.EFFORT, 'high');
      } else {
        const ok = await AkiCrypto.unlock(pw);
        if (!ok) {
          lockHint.textContent = 'パスワードが違います';
          lockUnlockBtn.disabled = false;
          lockPassInput.value = '';
          lockPassInput.focus();
          return;
        }
      }

      // Unlock successful
      lockScreen.classList.add('hidden');
      lockPassInput.value = '';
      await startApp();
    } catch (e) {
      lockHint.textContent = e.message;
      lockUnlockBtn.disabled = false;
    }
  }

  // ══════════════════════════════════
  // App Init (after unlock)
  // ══════════════════════════════════

  async function startApp() {
    // Grab DOM refs
    overlay         = $('overlay');
    sidebar         = $('sidebar');
    threadList      = $('threadList');
    menuBtn         = $('menuBtn');
    newThreadBtn    = $('newThreadBtn');
    chatMessages    = $('chatMessages');
    emptyState      = $('emptyState');
    messageInput    = $('messageInput');
    sendBtn         = $('sendBtn');
    topbarTitle     = $('topbarTitle');
    settingsOverlay = $('settingsOverlay');
    apiKeyInput     = $('apiKeyInput');
    modelSelect     = $('modelSelect');
    systemPrompt    = $('systemPromptInput');
    knowledgeInput  = $('knowledgeInput');
    knowledgeToggle = $('knowledgeToggle');
    maxTokensInput  = $('maxTokensInput');
    effortSelect    = $('effortSelect');
    renameOverlay   = $('renameOverlay');
    renameInput     = $('renameInput');
    imageInput      = $('imageInput');
    attachBtn       = $('attachBtn');
    attachPreview   = $('attachPreview');
    presetSelect    = $('presetSelect');
    presetSaveBtn   = $('presetSaveBtn');
    presetDelBtn    = $('presetDelBtn');

    try {
      await loadState();
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
      showToast('初期化エラー: ' + e.message);
    }
  }

  // ══════════════════════════════════
  // Encrypted Storage
  // ══════════════════════════════════

  async function sget(key) {
    return await AkiCrypto.secureGet(key);
  }

  async function sset(key, value) {
    try {
      await AkiCrypto.secureSet(key, value);
    } catch (e) {
      showToast(e.message);
    }
  }

  // ══════════════════════════════════
  // State
  // ══════════════════════════════════

  async function loadState() {
    if (apiKeyInput)     apiKeyInput.value    = (await sget(SK.API_KEY)) || '';
    if (modelSelect)     modelSelect.value    = (await sget(SK.MODEL))   || 'claude-fable-5';
    if (systemPrompt)    systemPrompt.value   = (await sget(SK.SYSTEM))  || '';
    if (knowledgeInput)  knowledgeInput.value  = (await sget(SK.KNOWLEDGE)) || '';
    if (knowledgeToggle) {
      const on = await sget(SK.KNOW_ON);
      knowledgeToggle.checked = on === null ? true : on === '1';
      syncKnowledgeLook();
    }
    if (maxTokensInput)  maxTokensInput.value  = (await sget(SK.MAX_TOK)) || '8192';
    if (effortSelect)    effortSelect.value    = (await sget(SK.EFFORT)) || 'high';

    try {
      const raw = await sget(SK.THREADS);
      threads = raw ? JSON.parse(raw) : [];
    } catch { threads = []; }

    activeId = (await sget(SK.ACTIVE)) || null;

    try {
      const rawP = await sget(SK.PRESETS);
      presets = rawP ? JSON.parse(rawP) : [];
    } catch { presets = []; }
  }

  function syncKnowledgeLook() {
    if (!knowledgeInput || !knowledgeToggle) return;
    knowledgeInput.classList.toggle('disabled-look', !knowledgeToggle.checked);
  }

  async function saveThreads() {
    await sset(SK.THREADS, JSON.stringify(threads));
    await sset(SK.ACTIVE, activeId || '');
  }

  async function saveSettings() {
    await sset(SK.API_KEY,   (apiKeyInput    && apiKeyInput.value    || '').trim());
    await sset(SK.MODEL,     (modelSelect    && modelSelect.value    || 'claude-fable-5'));
    await sset(SK.SYSTEM,    (systemPrompt   && systemPrompt.value   || ''));
    await sset(SK.KNOWLEDGE, (knowledgeInput && knowledgeInput.value || ''));
    await sset(SK.KNOW_ON,   (knowledgeToggle && knowledgeToggle.checked) ? '1' : '0');
    await sset(SK.MAX_TOK,   (maxTokensInput && maxTokensInput.value || '8192'));
    await sset(SK.EFFORT,    (effortSelect && effortSelect.value || 'high'));
  }

  // ══════════════════════════════════
  // Presets
  // ══════════════════════════════════

  async function savePresets() {
    await sset(SK.PRESETS, JSON.stringify(presets));
  }

  function renderPresetSelect(selectedId) {
    if (!presetSelect) return;
    presetSelect.innerHTML = '<option value="">— プリセット —</option>';
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === selectedId) opt.selected = true;
      presetSelect.appendChild(opt);
    });
    if (presetDelBtn) presetDelBtn.style.display = presetSelect.value ? '' : 'none';
  }

  function loadPresetIntoFields(preset) {
    if (!preset) return;
    if (systemPrompt)    systemPrompt.value   = preset.system || '';
    if (knowledgeInput)  knowledgeInput.value  = preset.knowledge || '';
    if (knowledgeToggle) {
      knowledgeToggle.checked = preset.knowOn !== false;
      syncKnowledgeLook();
    }
  }

  async function handlePresetSave() {
    const sys  = systemPrompt  ? systemPrompt.value.trim()  : '';
    const know = knowledgeInput ? knowledgeInput.value.trim() : '';
    const knowOn = knowledgeToggle ? knowledgeToggle.checked : true;
    if (!sys && !know) { showToast('保存する内容がありません'); return; }

    const currentId = presetSelect ? presetSelect.value : '';
    const currentPreset = currentId ? presets.find(p => p.id === currentId) : null;
    const defaultName = currentPreset ? currentPreset.name : '';

    const name = prompt('プリセット名', defaultName);
    if (!name || !name.trim()) return;

    if (currentPreset && name.trim() === currentPreset.name) {
      // Overwrite existing
      currentPreset.system = sys;
      currentPreset.knowledge = know;
      currentPreset.knowOn = knowOn;
    } else {
      // New preset
      const p = { id: 'ps_' + Date.now(), name: name.trim(), system: sys, knowledge: know, knowOn };
      presets.push(p);
      renderPresetSelect(p.id);
    }
    await savePresets();
    renderPresetSelect(presetSelect.value);
    showToast('保存しました');
  }

  async function handlePresetDelete() {
    const id = presetSelect ? presetSelect.value : '';
    if (!id) return;
    const p = presets.find(p => p.id === id);
    if (!p) return;
    if (!confirm(`「${p.name}」を削除する？`)) return;
    presets = presets.filter(p => p.id !== id);
    await savePresets();
    renderPresetSelect('');
    showToast('削除しました');
  }

  // ══════════════════════════════════
  // Image Processing
  // ══════════════════════════════════

  const MAX_IMG_DIM = 800;
  const IMG_QUALITY = 0.8;

  function resizeAndCompress(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > MAX_IMG_DIM || height > MAX_IMG_DIM) {
            if (width > height) { height = Math.round(height * MAX_IMG_DIM / width); width = MAX_IMG_DIM; }
            else { width = Math.round(width * MAX_IMG_DIM / height); height = MAX_IMG_DIM; }
          }
          const c = document.createElement('canvas'); c.width = width; c.height = height;
          c.getContext('2d').drawImage(img, 0, 0, width, height);
          const fullBase64 = c.toDataURL('image/jpeg', IMG_QUALITY).split(',')[1];
          const ts = 120; let tw = ts, th = ts;
          if (width > height) { th = Math.round(height * ts / width); } else { tw = Math.round(width * ts / height); }
          const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
          tc.getContext('2d').drawImage(img, 0, 0, tw, th);
          resolve({ data: fullBase64, mediaType: 'image/jpeg', thumbnail: tc.toDataURL('image/jpeg', 0.6) });
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
      thumb.innerHTML = `<img src="${img.thumbnail}" alt=""><div class="attach-thumb-remove" data-idx="${i}">✕</div>`;
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

  // ══════════════════════════════════
  // Thread CRUD
  // ══════════════════════════════════

  function createThread(name) {
    cleanEmptyThreads();
    const t = { id: 't_' + Date.now(), name: name || '新しいスレッド', messages: [], created: Date.now() };
    threads.unshift(t);
    saveThreads();
    renderThreadList();
    switchThread(t.id);
    return t;
  }

  function deleteThread(id) {
    threads = threads.filter(t => t.id !== id);
    if (activeId === id) activeId = threads.length ? threads[0].id : null;
    saveThreads();
    renderThreadList();
    if (activeId) switchThread(activeId); else renderMessages();
  }

  function renameThread(id, name) {
    const t = threads.find(t => t.id === id);
    if (t) { t.name = name; saveThreads(); renderThreadList(); updateTopbar(); }
  }

  function cleanEmptyThreads() {
    const before = threads.length;
    threads = threads.filter(t => t.messages.length > 0);
    if (threads.length !== before) {
      if (activeId && !threads.find(t => t.id === activeId)) activeId = threads.length ? threads[0].id : null;
      saveThreads();
    }
  }

  function getActive() { return threads.find(t => t.id === activeId) || null; }

  function switchThread(id) {
    if (activeId && activeId !== id) {
      const prev = threads.find(t => t.id === activeId);
      if (prev && prev.messages.length === 0) threads = threads.filter(t => t.id !== activeId);
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

  // ══════════════════════════════════
  // Render
  // ══════════════════════════════════

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
        </div>`;
      el.addEventListener('click', (e) => { if (!e.target.closest('.thread-action-btn')) switchThread(t.id); });
      threadList.appendChild(el);
    });
    threadList.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openRename(btn.dataset.id); });
    });
    threadList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('このスレッドを削除する？')) deleteThread(btn.dataset.id); });
    });
  }

  function renderMessages(forceScroll) {
    if (forceScroll === undefined) forceScroll = true;
    chatMessages.innerHTML = '';
    const t = getActive();
    if (!t || t.messages.length === 0) {
      chatMessages.appendChild(emptyState);
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    t.messages.forEach((m, idx) => chatMessages.appendChild(createMsgEl(m, idx)));
    if (forceScroll) scrollToBottom(true);
  }

  function shortModel(id) {
    return (id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }
  function fmtTok(n) {
    if (!n) return '0';
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  }

  function createMsgEl(m, msgIndex) {
    const role = m.role;
    const content = m.text || m.content || '';
    const images = m.images;
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    let imagesHtml = '';
    if (images && images.length > 0) {
      imagesHtml = '<div class="msg-images">' + images.map(img => `<img src="${img.thumbnail || img}" alt="">`).join('') + '</div>';
    }
    let thinkingHtml = '';
    if (m.thinking) {
      thinkingHtml = `<div class="msg-thinking collapsed"><div class="msg-thinking-toggle">thinking</div><div class="msg-thinking-body"></div></div>`;
    }
    let actionsHtml = '<div class="msg-actions">';
    actionsHtml += `<button class="msg-action copy-action" data-idx="${msgIndex}">copy</button>`;
    if (role === 'user') actionsHtml += `<button class="msg-action edit-action" data-idx="${msgIndex}">edit</button>`;
    if (role === 'assistant') actionsHtml += `<button class="msg-action retry-action" data-idx="${msgIndex}">retry</button>`;
    actionsHtml += '</div>';
    let metaHtml = '';
    if (role === 'assistant' && m.meta) {
      const mt = m.meta;
      const totalIn = (mt.inTok || 0) + (mt.cacheRead || 0) + (mt.cacheWrite || 0);
      const parts = [];
      if (mt.model) parts.push(esc(shortModel(mt.model)));
      parts.push(`↑${fmtTok(totalIn)} ↓${fmtTok(mt.outTok)}`);
      if (mt.stopReason === 'max_tokens') parts.push('max_tokens');
      const detail = `in ${mt.inTok || 0} / cache read ${mt.cacheRead || 0} / cache write ${mt.cacheWrite || 0} / out ${mt.outTok || 0}`;
      metaHtml = `<div class="msg-meta" title="${esc(detail)}">${parts.join(' · ')}</div>`;
    }
    el.innerHTML = `${imagesHtml}${thinkingHtml}<div class="msg-content"></div>${actionsHtml}${metaHtml}`;
    el.querySelector('.msg-content').textContent = content;
    if (m.thinking) {
      el.querySelector('.msg-thinking-body').textContent = m.thinking;
      el.querySelector('.msg-thinking-toggle').addEventListener('click', () => {
        el.querySelector('.msg-thinking').classList.toggle('collapsed');
      });
    }
    el.querySelector('.copy-action').addEventListener('click', () => copyToClipboard(content));
    const editBtn = el.querySelector('.edit-action');
    if (editBtn) editBtn.addEventListener('click', () => { if (!streaming) startEdit(msgIndex); });
    const retryBtn = el.querySelector('.retry-action');
    if (retryBtn) retryBtn.addEventListener('click', () => { if (!streaming) startRetry(msgIndex); });
    return el;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('コピーしました')).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('コピーしました'); } catch { showToast('コピーに失敗しました'); }
    document.body.removeChild(ta);
  }

  function startEdit(msgIndex) {
    const t = getActive();
    if (!t) return;
    const msg = t.messages[msgIndex];
    if (!msg || msg.role !== 'user') return;
    messageInput.value = msg.text || msg.content || '';
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    messageInput.focus();
    t.messages = t.messages.slice(0, msgIndex);
    saveThreads();
    renderMessages();
    updateSendBtn();
  }

  async function startRetry(msgIndex) {
    const t = getActive();
    if (!t) return;
    const msg = t.messages[msgIndex];
    if (!msg || msg.role !== 'assistant') return;

    // Remove this assistant message and everything after it
    t.messages = t.messages.slice(0, msgIndex);
    await saveThreads();
    renderMessages();

    // Find the last user message and re-send
    const lastUserMsg = t.messages[t.messages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== 'user') return;

    // Remove the user message too (sendMessage will re-add it)
    const userText = lastUserMsg.text || lastUserMsg.content || '';
    const userImages = lastUserMsg.apiImages || null;
    t.messages = t.messages.slice(0, -1);
    await saveThreads();
    renderMessages();

    sendMessage(userText, userImages);
  }

  function updateTopbar() {
    const t = getActive();
    topbarTitle.textContent = t ? t.name : '⊹';
  }

  let autoScroll = true;

  function isNearBottom() {
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 10;
  }

  function scrollToBottom(force) {
    if (!force && !autoScroll) return;
    if (!force && !isNearBottom()) return;
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // ══════════════════════════════════
  // API
  // ══════════════════════════════════

  async function buildSystemPrompt() {
    const sys    = (await sget(SK.SYSTEM)) || '';
    const know   = (await sget(SK.KNOWLEDGE)) || '';
    const knowOn = await sget(SK.KNOW_ON);
    const isOn   = knowOn === null ? true : knowOn === '1';
    const blocks = [];
    if (sys.trim()) blocks.push({ type: 'text', text: sys.trim() });
    if (isOn && know.trim()) blocks.push({ type: 'text', text: '<knowledge>\n' + know.trim() + '\n</knowledge>' });
    if (blocks.length > 0) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
    return blocks;
  }

  function buildUserContent(text, images) {
    if (!images || images.length === 0) return text;
    const content = [];
    images.forEach(img => { content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }); });
    if (text) content.push({ type: 'text', text });
    return content;
  }

  function buildApiMessages(messages) {
    return messages.map(m => {
      if (m.role === 'user' && m.apiImages && m.apiImages.length > 0) {
        return { role: 'user', content: buildUserContent(m.text || m.content, m.apiImages) };
      }
      return { role: m.role, content: m.text || m.content };
    });
  }

  async function sendMessage(text, images) {
    if (streaming) return;
    const apiKey = await sget(SK.API_KEY);
    if (!apiKey) { showToast('APIキーを設定してください'); openSettings(); return; }

    let t = getActive();
    if (!t) t = createThread();

    const msgObj = {
      role: 'user', text, content: text,
      images: images ? images.map(i => ({ thumbnail: i.thumbnail })) : [],
      apiImages: images || [],
    };
    t.messages.push(msgObj);
    await saveThreads();

    emptyState.style.display = 'none';
    if (emptyState.parentNode === chatMessages) chatMessages.removeChild(emptyState);

    chatMessages.appendChild(createMsgEl(msgObj, t.messages.length - 1));
    scrollToBottom(true);

    if (t.messages.length === 1 && t.name === '新しいスレッド') {
      renameThread(t.id, text.slice(0, 20) + (text.length > 20 ? '…' : ''));
    }

    const apiMessages = buildApiMessages(t.messages);
    const asstEl = document.createElement('div');
    asstEl.className = 'msg assistant streaming';
    asstEl.innerHTML = `
      <div class="msg-thinking" style="display:none">
        <div class="msg-thinking-toggle">thinking</div>
        <div class="msg-thinking-body"></div>
      </div>
      <div class="msg-content"></div>`;
    chatMessages.appendChild(asstEl);
    const contentEl   = asstEl.querySelector('.msg-content');
    const thinkWrap   = asstEl.querySelector('.msg-thinking');
    const thinkBody   = asstEl.querySelector('.msg-thinking-body');
    thinkWrap.querySelector('.msg-thinking-toggle').addEventListener('click', () => {
      thinkWrap.classList.toggle('collapsed');
    });
    scrollToBottom(true);

    streaming = true;
    autoScroll = true;
    updateSendBtn();
    abortCtrl = new AbortController();
    let fullResponse = '';
    let fullThinking = '';
    const meta = { model: null, inTok: 0, cacheRead: 0, cacheWrite: 0, outTok: 0, stopReason: null };

    try {
      const model    = (await sget(SK.MODEL)) || 'claude-fable-5';
      const maxTok   = parseInt((await sget(SK.MAX_TOK)) || '8192');
      const effort   = (await sget(SK.EFFORT)) || 'none';
      const budget   = EFFORT_MAP[effort] || 0;
      const sysBlocks = await buildSystemPrompt();

      const body = { model, max_tokens: maxTok, stream: true, messages: apiMessages };
      if (sysBlocks.length > 0) body.system = sysBlocks;

      if (effort !== 'none') {
        // Fable 5 / Opus 4.7以降: thinking.type=adaptive + output_config.effort
        // それ以前: thinking.type=enabled + budget_tokens
        const isAdaptive = /fable|opus-4-[789]/.test(model);
        if (isAdaptive) {
          body.thinking = { type: 'adaptive' };
          body.output_config = { effort: effort };
          if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
        } else if (budget > 0) {
          if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
          body.thinking = { type: 'enabled', budget_tokens: budget };
        }
      }

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
            if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
                fullThinking += evt.delta.thinking;
                thinkWrap.style.display = '';
                thinkBody.textContent = fullThinking;
                thinkBody.scrollTop = thinkBody.scrollHeight;
                scrollToBottom();
              } else if (evt.delta?.text) {
                if (!fullResponse && fullThinking) thinkWrap.classList.add('collapsed');
                fullResponse += evt.delta.text;
                contentEl.textContent = fullResponse;
                scrollToBottom();
              }
            } else if (evt.type === 'message_start') {
              const u = evt.message?.usage || {};
              meta.model      = evt.message?.model || null;
              meta.inTok      = u.input_tokens || 0;
              meta.cacheRead  = u.cache_read_input_tokens || 0;
              meta.cacheWrite = u.cache_creation_input_tokens || 0;
            } else if (evt.type === 'message_delta') {
              if (evt.usage?.output_tokens) meta.outTok = evt.usage.output_tokens;
              if (evt.delta?.stop_reason)   meta.stopReason = evt.delta.stop_reason;
            } else if (evt.type === 'error') {
              throw new Error(evt.error?.message || 'Stream error');
            }
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e; // JSON破片のみ無視
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        showToast(err.message);
      }
    } finally {
      streaming = false;
      abortCtrl = null;
      asstEl.classList.remove('streaming');
      if (fullResponse || fullThinking) {
        const m = { role: 'assistant', text: fullResponse, content: fullResponse };
        if (fullThinking) m.thinking = fullThinking;
        if (meta.model || meta.outTok) m.meta = meta;
        t.messages.push(m);
        await saveThreads();
        renderMessages(autoScroll);
      } else {
        asstEl.remove();
      }
      autoScroll = true;
      updateSendBtn();
    }
  }

  // ══════════════════════════════════
  // UI Events
  // ══════════════════════════════════

  function bindEvents() {
    menuBtn.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', closeSidebar);
    newThreadBtn.addEventListener('click', () => createThread());

    $('openSettingsBtn').addEventListener('click', openSettings);
    $('topbarSettingsBtn').addEventListener('click', openSettings);
    $('closeSettingsBtn').addEventListener('click', closeSettings);
    $('saveSettingsBtn').addEventListener('click', async () => { await saveSettings(); closeSettings(); });
    settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

    $('toggleKeyVis').addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });

    if (knowledgeToggle) knowledgeToggle.addEventListener('change', syncKnowledgeLook);

    // Presets
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        const id = presetSelect.value;
        const p = presets.find(p => p.id === id);
        if (p) loadPresetIntoFields(p);
        if (presetDelBtn) presetDelBtn.style.display = id ? '' : 'none';
      });
    }
    if (presetSaveBtn) presetSaveBtn.addEventListener('click', handlePresetSave);
    if (presetDelBtn)  presetDelBtn.addEventListener('click', handlePresetDelete);

    $('closeRenameBtn').addEventListener('click', closeRename);
    renameOverlay.addEventListener('click', (e) => { if (e.target === renameOverlay) closeRename(); });

    attachBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', async () => {
      const files = Array.from(imageInput.files);
      for (const file of files) {
        try { pendingImages.push(await resizeAndCompress(file)); } catch (e) { showToast(e.message); }
      }
      renderAttachPreview();
      updateSendBtn();
      imageInput.value = '';
    });

    sendBtn.addEventListener('click', handleSend);
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        if (isMobile) return;
        if (!e.shiftKey) { e.preventDefault(); handleSend(); }
      }
    });
    messageInput.addEventListener('input', updateSendBtn);
    messageInput.addEventListener('compositionend', updateSendBtn);

    // ストリーミング中にユーザーが上方向にスクロールしたら自動追従を切る
    chatMessages.addEventListener('wheel', (e) => {
      if (streaming && e.deltaY < 0) autoScroll = false;
    }, { passive: true });

    let touchStartY = 0;
    chatMessages.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
    }, { passive: true });
    chatMessages.addEventListener('touchmove', (e) => {
      if (streaming && e.touches.length === 1 && e.touches[0].clientY > touchStartY) {
        autoScroll = false;
      }
    }, { passive: true });
  }

  function handleSend() {
    if (streaming) {
      // ストリーミング中は停止ボタンとして機能（途中までの応答は保存される）
      if (abortCtrl) abortCtrl.abort();
      return;
    }
    const text = messageInput.value.trim();
    const images = pendingImages.length > 0 ? [...pendingImages] : null;
    if (!text && !images) return;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    pendingImages = [];
    renderAttachPreview();
    updateSendBtn();
    sendMessage(text, images);
  }

  const SVG_SEND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const SVG_STOP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;

  function updateSendBtn() {
    if (streaming) {
      sendBtn.disabled = false;
      sendBtn.classList.add('stop-mode');
      sendBtn.innerHTML = SVG_STOP;
      sendBtn.title = '停止';
    } else {
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = SVG_SEND;
      sendBtn.title = '';
      sendBtn.disabled = !messageInput.value.trim() && pendingImages.length === 0;
    }
  }

  function toggleSidebar() { sidebar.classList.toggle('open'); overlay.classList.toggle('open'); }
  function closeSidebar()  { sidebar.classList.remove('open'); overlay.classList.remove('open'); }

  async function openSettings() {
    closeSidebar();
    if (apiKeyInput)     apiKeyInput.value    = (await sget(SK.API_KEY)) || '';
    if (modelSelect)     modelSelect.value    = (await sget(SK.MODEL))   || 'claude-fable-5';
    if (systemPrompt)    systemPrompt.value   = (await sget(SK.SYSTEM))  || '';
    if (knowledgeInput)  knowledgeInput.value  = (await sget(SK.KNOWLEDGE)) || '';
    if (knowledgeToggle) {
      const on = await sget(SK.KNOW_ON);
      knowledgeToggle.checked = on === null ? true : on === '1';
      syncKnowledgeLook();
    }
    if (maxTokensInput)  maxTokensInput.value  = (await sget(SK.MAX_TOK)) || '8192';
    if (effortSelect)    effortSelect.value    = (await sget(SK.EFFORT)) || 'high';
    renderPresetSelect('');
    settingsOverlay.classList.add('open');
  }

  function closeSettings() { settingsOverlay.classList.remove('open'); }

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
    renameInput.onkeydown = (e) => { if (e.key === 'Enter') $('saveRenameBtn').click(); };
  }
  function closeRename() { renameOverlay.classList.remove('open'); renamingId = null; }

  let toastEl = null;
  function showToast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  function autoResize(el) {
    el.addEventListener('input', () => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; });
  }

  function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  // ══════════════════════════════════
  // Start: show lock screen
  // ══════════════════════════════════
  initLockScreen();

})();
