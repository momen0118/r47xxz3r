/* ============================
   燈 — Encryption Layer
   Web Crypto API: PBKDF2 → AES-GCM
   ============================ */

const AkiCrypto = (() => {
  'use strict';

  const SALT_KEY   = 'aki_salt';
  const VERIFY_KEY = 'aki_verify';
  const VERIFY_PLAINTEXT = 'aki_unlock_ok';

  let _key = null; // CryptoKey in memory, never stored

  // ── Helpers ──
  function buf2hex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function hex2buf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // ── Key derivation ──
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Encrypt / Decrypt ──
  async function encrypt(plaintext) {
    if (!_key) throw new Error('Not unlocked');
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      _key,
      enc.encode(plaintext)
    );
    // Format: hex(iv) + ':' + hex(ciphertext)
    return buf2hex(iv) + ':' + buf2hex(ct);
  }

  async function decrypt(ciphertext) {
    if (!_key) throw new Error('Not unlocked');
    const [ivHex, ctHex] = ciphertext.split(':');
    if (!ivHex || !ctHex) throw new Error('Invalid format');
    const iv = hex2buf(ivHex);
    const ct = hex2buf(ctHex);
    const dec = new TextDecoder();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      _key,
      ct
    );
    return dec.decode(plain);
  }

  // ── Public API ──

  function isSetup() {
    return !!(localStorage.getItem(SALT_KEY) && localStorage.getItem(VERIFY_KEY));
  }

  async function setup(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    _key = await deriveKey(password, salt);

    // Store salt
    localStorage.setItem(SALT_KEY, buf2hex(salt));

    // Encrypt verification token
    const verifyEnc = await encrypt(VERIFY_PLAINTEXT);
    localStorage.setItem(VERIFY_KEY, verifyEnc);

    return true;
  }

  async function unlock(password) {
    const saltHex = localStorage.getItem(SALT_KEY);
    const verifyEnc = localStorage.getItem(VERIFY_KEY);
    if (!saltHex || !verifyEnc) return false;

    const salt = hex2buf(saltHex);
    _key = await deriveKey(password, salt);

    try {
      const result = await decrypt(verifyEnc);
      if (result === VERIFY_PLAINTEXT) return true;
    } catch {
      // Wrong password → decryption fails
    }
    _key = null;
    return false;
  }

  function isUnlocked() {
    return _key !== null;
  }

  // ── Secure storage: encrypt then store, load then decrypt ──

  async function secureSet(key, value) {
    const encrypted = await encrypt(value);
    try {
      localStorage.setItem(key, encrypted);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        throw new Error('ストレージ容量不足');
      }
      throw e;
    }
  }

  async function secureGet(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return await decrypt(raw);
    } catch {
      return null; // corrupted or wrong key
    }
  }

  async function secureRemove(key) {
    localStorage.removeItem(key);
  }

  // ── Password change ──
  async function changePassword(oldPassword, newPassword) {
    // Verify old password
    const ok = await unlock(oldPassword);
    if (!ok) return false;

    // Read all encrypted data
    const allKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== SALT_KEY && k !== VERIFY_KEY) {
        allKeys.push(k);
      }
    }

    const data = {};
    for (const k of allKeys) {
      try {
        data[k] = await decrypt(localStorage.getItem(k));
      } catch {
        // Not encrypted or different format, keep raw
        data[k] = { raw: localStorage.getItem(k) };
      }
    }

    // Setup new password
    await setup(newPassword);

    // Re-encrypt all data
    for (const k of allKeys) {
      if (data[k] && data[k].raw !== undefined) {
        localStorage.setItem(k, data[k].raw);
      } else {
        await secureSet(k, data[k]);
      }
    }

    return true;
  }

  return {
    isSetup,
    setup,
    unlock,
    isUnlocked,
    encrypt,
    decrypt,
    secureSet,
    secureGet,
    secureRemove,
    changePassword,
  };
})();
