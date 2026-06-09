// ==UserScript==
// @name         JanitorAI Kokoro TTS
// @namespace    url
// @version      1.5.0
// @description  Read JanitorAI messages, selected text, or typed text with a private Kokoro Cloud Run API.
// @author       Kaushik Paul
// @match        https://janitorai.com/*
// @match        https://www.janitorai.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=janitorai.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      www.url
// @connect      url
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULTS = {
    apiUrl: '<API URL>',
    apiKey: '<Password>',
    voice: 'af_heart',
    speed: 1,
    collapsed: false,
    manualText: '',
  };

  const STORAGE_KEY = 'janitor-kokoro-tts-settings-v2';
  const ROOT_ID = 'kokoro-tts-root';
  const MAX_TEXT_CHARS = 5900;
  const CLIENT_CHUNK_CHARS = 2400;
  const ACTION_TEXT_PATTERN = /^(copy|edit|copy\s*edit|copyedit|delete|regenerate|continue|retry|swipe|report|more|less)$/i;

  let settings = loadSettings();
  let root;
  let statusEl;
  let latestPreviewEl;
  let manualTextEl;
  let voiceSelectEl;
  let speedInputEl;
  let apiUrlInputEl;
  let apiKeyInputEl;
  let replayButtonEl;
  let backButtonEl;
  let pauseButtonEl;
  let forwardButtonEl;
  let progressInputEl;
  let timeEl;

  let rememberedSelection = '';
  let activeAudioContext = null;
  let activeAudioSource = null;
  let activePlaybackResolve = null;
  let activeAudioBuffer = null;
  let playbackOffset = 0;
  let playbackStartedAt = 0;
  let playbackTimer = null;
  let isPlaybackPaused = true;
  const activeRequests = new Set();
  let stopRequested = false;
  let voicesLoaded = false;

  function loadSettings() {
    try {
      return {
        ...DEFAULTS,
        ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function cleanBaseUrl(value) {
    return String(value || DEFAULTS.apiUrl).trim().replace(/\/+$/, '');
  }

  function setStatus(message, tone = 'info') {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  }

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/[ \t]{3,}/g, '  ')
      .trim();
  }

  function textForSpeech(value) {
    return normalizeText(value).slice(0, MAX_TEXT_CHARS);
  }

  function stripActionText(value) {
    return String(value || '')
      .replace(/(?:^|\n)\s*(copy\s*edit|copyedit|copy|edit|delete|regenerate|continue|retry|swipe|report|more|less)\s*(?=\n|$)/giu, '\n')
      .replace(/(copy\s*edit|copyedit)\s*$/iu, '')
      .replace(/(?:\s|\n)+(copy\s*edit|copyedit|copy|edit|delete|regenerate|continue|retry|swipe|report|more|less)(?:\s+(copy\s*edit|copyedit|copy|edit|delete|regenerate|continue|retry|swipe|report|more|less))*\s*$/iu, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function cleanExtractedMessageText(value) {
    return stripActionText(textForSpeech(value)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => !ACTION_TEXT_PATTERN.test(line.trim()))
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim());
  }

  function updateRememberedSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const anchor = selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement;

    if (anchor?.closest?.(`#${ROOT_ID}`)) return;

    const text = textForSpeech(selection.toString());
    if (text) {
      rememberedSelection = text;
      setStatus(`Selection saved (${text.length} chars).`, 'info');
    }
  }

  function getCurrentSelectionText() {
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed ? selection.toString() : '';
    return textForSpeech(selected || rememberedSelection);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 40
      && rect.height > 18
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0
    );
  }

  function uiTextNoisePattern() {
    return new RegExp([
      'Kokoro TTS',
      'Read latest',
      'Read selected',
      'Read box',
      'Stop',
      'Voice',
      'Speed',
      'API URL',
      'API key',
      'Text box',
      'Advanced',
      'CopyEdit',
      'Copy Edit',
      'selection saved',
      'loading voices',
    ].map(escapeRegExp).join('|'), 'i');
  }

  function isUsefulMessageText(text) {
    const value = normalizeText(text);
    if (value.length < 8) return false;
    if (value.length > MAX_TEXT_CHARS * 2) return false;
    if (uiTextNoisePattern().test(value)) return false;
    return /[A-Za-z0-9]/.test(value);
  }

  function elementSignature(element) {
    return [
      element.id,
      element.className,
      element.getAttribute('data-testid'),
      element.getAttribute('data-role'),
      element.getAttribute('data-author'),
      element.getAttribute('aria-label'),
      element.parentElement?.className,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function visibleTextWithoutControls(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      'button',
      'input',
      'select',
      'textarea',
      'nav',
      'header',
      'footer',
      '[role="button"]',
      '[role="menu"]',
      '[aria-label*="copy" i]',
      '[aria-label*="edit" i]',
    ].join(',')).forEach((node) => node.remove());

    return cleanExtractedMessageText(clone.innerText || clone.textContent || '');
  }

  function markdownFromNode(node) {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const element = node;
    const tagName = element.tagName.toLowerCase();

    if (element.matches([
      'button',
      'input',
      'select',
      'textarea',
      'svg',
      'img',
      '[role="button"]',
      '[role="menu"]',
      '[class*="messageControls" i]',
      '[class*="messageFooter" i]',
      '[class*="messageAvatar" i]',
      '[class*="nameContainer" i]',
      '[class*="nameText" i]',
      '[aria-label*="copy" i]',
      '[aria-label*="edit" i]',
    ].join(','))) {
      return '';
    }

    if (tagName === 'br') {
      return '\n';
    }

    const childText = Array.from(element.childNodes)
      .map(markdownFromNode)
      .join('');

    if (!childText.trim()) {
      return '';
    }

    if (tagName === 'strong' || tagName === 'b') {
      return `**${childText.trim()}**`;
    }

    if (tagName === 'em' || tagName === 'i') {
      return `*${childText.trim()}*`;
    }

    if (/^(p|div|li|blockquote|section|article)$/i.test(tagName)) {
      return `${childText.trim()}\n\n`;
    }

    return childText;
  }

  function messageContentElement(wrapper) {
    const body = wrapper.querySelector('[class*="messageBody" i]');
    if (!body) return wrapper;

    const content = body.querySelector(':scope > .css-17apud6');
    if (content) return content;

    const bodyChildren = Array.from(body.children).filter((child) => (
      !child.matches('[class*="nameContainer" i], [class*="messageFooter" i], [class*="messageAvatar" i]')
    ));

    return bodyChildren.at(-1) || body;
  }

  function messageWrapperFromAvatar(avatar) {
    return (
      avatar.closest('li[class*="messageDisplayWrapper" i]')
      || avatar.closest('[class*="messageDisplayWrapper" i]')
      || avatar.closest('[data-index]')?.querySelector('li[class*="messageDisplayWrapper" i], [class*="messageDisplayWrapper" i]')
      || avatar.closest('[data-index]')
    );
  }

  function messageWrapperText(wrapper) {
    const content = messageContentElement(wrapper);
    return cleanExtractedMessageText(markdownFromNode(content));
  }

  function messageVirtualIndex(wrapper) {
    const indexedParent = wrapper.closest('[data-index]');
    const index = Number.parseInt(indexedParent?.getAttribute('data-index') || '', 10);
    if (Number.isFinite(index)) return index;

    const rect = wrapper.getBoundingClientRect();
    return Math.round(window.scrollY + rect.top);
  }

  function isBotMessageWrapper(wrapper) {
    if (wrapper.querySelector('img[src*="/bot-avatars/"], img[alt="Character Icon"]')) return true;
    if (wrapper.querySelector('button[aria-label="Delete"]')) return false;
    return isLikelyAssistantMessage(wrapper, messageWrapperText(wrapper));
  }

  function findLatestRenderedBotText() {
    const avatarWrappers = Array.from(document.querySelectorAll(
      'img[src*="/bot-avatars/"], img[alt="Character Icon"]',
    )).map(messageWrapperFromAvatar).filter(Boolean);

    const wrappers = Array.from(new Set([
      ...avatarWrappers,
      ...Array.from(document.querySelectorAll([
      'li[class*="messageDisplayWrapper" i]',
      '[class*="botChoicesSlider" i] li',
      '[class*="messageDisplayWrapper" i]',
      ].join(','))),
    ])).filter((element) => (
      element instanceof HTMLElement
      && !element.closest(`#${ROOT_ID}`)
      && isBotMessageWrapper(element)
    )).map((element, order) => ({
      element,
      order,
      index: messageVirtualIndex(element),
    })).sort((left, right) => (
      right.index - left.index
      || right.order - left.order
    ));

    for (const candidate of wrappers) {
      const text = messageWrapperText(candidate.element);
      if (isUsefulMessageText(text)) return text;
    }

    return '';
  }

  function isLikelyUserMessage(element, text) {
    const signature = elementSignature(element);
    if (/(^|[\s_-])(user|human|you|outgoing|sent|self)([\s_-]|$)/.test(signature)) return true;
    if (/\buser\s*message\b|\byour\s*message\b/.test(signature)) return true;
    if (/^\s*(you|me)\s*:/i.test(text)) return true;
    return false;
  }

  function isLikelyAssistantMessage(element, text) {
    const signature = elementSignature(element);
    if (/assistant|bot|character|incoming|char-message|ai-message|model/.test(signature)) return true;
    if (/^[^:\n]{1,32}:\s/.test(text) && !/^\s*(you|me|user)\s*:/i.test(text)) return true;
    return false;
  }

  function scoreCandidate(element, index, total) {
    const signature = elementSignature(element);
    const text = normalizeText(visibleTextWithoutControls(element));
    const rect = element.getBoundingClientRect();
    let score = (window.scrollY + rect.bottom) / 100;

    score += index / Math.max(total, 1);
    if (isLikelyAssistantMessage(element, text)) score += 40;
    if (isLikelyUserMessage(element, text)) score -= 80;
    if (/message|chat|markdown|prose/.test(signature)) score += 2;
    if (/textarea|input|button|nav|menu|dialog|toolbar|footer|header|composer|form/.test(signature)) score -= 40;
    if (/^[^:]{1,32}:\s/.test(text)) score += 1;
    if (/\*\*[^*]+\*\*|\*[^*]+\*/.test(text)) score += 1;
    if (text.length > 80) score += 1;
    if (text.length > 2500) score -= 5;
    if (element.querySelectorAll('[data-message-id], [data-testid*="message" i], article').length > 2) score -= 60;

    return score;
  }

  function collectCandidates() {
    const selectors = [
      'li[class*="messageDisplayWrapper" i]',
      '[class*="messageDisplayWrapper" i]',
      '[data-message-id]',
      '[data-testid*="chat-message" i]',
      '[data-testid*="message" i]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[class*="assistant" i]',
      '[class*="bot" i]',
      '[class*="character" i]',
      '[class*="message" i]',
      '[class*="markdown" i]',
      '[class*="prose" i]',
      'article',
    ].filter(Boolean);

    const unique = new Set();
    const candidates = [];

    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (!(element instanceof HTMLElement)) continue;
          if (unique.has(element)) continue;
          unique.add(element);

          if (!visible(element)) continue;
          if (element.closest(`#${ROOT_ID}`)) continue;
          if (element.closest('textarea, input, select, button, nav, header, footer, aside, [role="dialog"], [role="menu"]')) continue;

          const text = visibleTextWithoutControls(element);
          if (!isUsefulMessageText(text)) continue;
          if (isLikelyUserMessage(element, text) && !isLikelyAssistantMessage(element, text)) continue;

          candidates.push({ element, text });
        }
      } catch (error) {
        setStatus(`Selector ignored: ${error.message}`, 'warn');
      }
    }

    return candidates.filter((candidate) => !candidates.some((other) => {
      if (candidate === other) return false;
      if (!candidate.element.contains(other.element)) return false;
      return other.text.length >= Math.min(candidate.text.length * 0.6, candidate.text.length - 20);
    }));
  }

  function findLatestText() {
    const renderedBotText = findLatestRenderedBotText();
    if (renderedBotText) {
      latestPreviewEl.textContent = renderedBotText.length > 180 ? `${renderedBotText.slice(0, 180)}...` : renderedBotText;
      return renderedBotText;
    }

    const candidates = collectCandidates();

    if (!candidates.length) {
      latestPreviewEl.textContent = 'No message found. Use selected text or the text box.';
      return '';
    }

    const readableCandidates = candidates.filter((candidate) => (
      isLikelyAssistantMessage(candidate.element, candidate.text)
      && !isLikelyUserMessage(candidate.element, candidate.text)
    ));
    const searchPool = readableCandidates.length ? readableCandidates : candidates;
    let best = searchPool[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    searchPool.forEach((candidate, index) => {
      const score = scoreCandidate(candidate.element, index, searchPool.length);
      if (score >= bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    const text = cleanExtractedMessageText(best.text);
    latestPreviewEl.textContent = text.length > 180 ? `${text.slice(0, 180)}...` : text;
    return text;
  }

  function splitLongText(value, maxLength) {
    const chunks = [];
    const sentences = value.match(/[^.!?\n]+(?:[.!?]+["'”’)]*|$)/gu) || [value];
    let current = '';

    function pushCurrent() {
      const text = current.trim();
      if (text) chunks.push(text);
      current = '';
    }

    for (const sentenceValue of sentences) {
      const sentence = sentenceValue.trim();
      if (!sentence) continue;

      if (sentence.length > maxLength) {
        pushCurrent();
        for (const word of sentence.split(/\s+/u)) {
          const next = current ? `${current} ${word}` : word;
          if (next.length <= maxLength) {
            current = next;
          } else {
            pushCurrent();
            current = word;
          }
        }
        pushCurrent();
      } else if (!current) {
        current = sentence;
      } else if (`${current} ${sentence}`.length <= maxLength) {
        current += ` ${sentence}`;
      } else {
        pushCurrent();
        current = sentence;
      }
    }

    pushCurrent();
    return chunks;
  }

  function splitTextForRequests(text) {
    const prepared = textForSpeech(text);
    if (!prepared || prepared.length <= CLIENT_CHUNK_CHARS) return prepared ? [prepared] : [];

    const chunks = [];
    let current = '';

    function pushCurrent() {
      const text = current.trim();
      if (text) chunks.push(text);
      current = '';
    }

    for (const paragraph of prepared.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean)) {
      if (paragraph.length > CLIENT_CHUNK_CHARS) {
        pushCurrent();
        chunks.push(...splitLongText(paragraph, CLIENT_CHUNK_CHARS));
      } else if (!current) {
        current = paragraph;
      } else if (`${current}\n\n${paragraph}`.length <= CLIENT_CHUNK_CHARS) {
        current += `\n\n${paragraph}`;
      } else {
        pushCurrent();
        current = paragraph;
      }
    }

    pushCurrent();
    return chunks;
  }

  function decodeResponseBody(response) {
    const data = response.response;
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) {
      try {
        return new TextDecoder().decode(new Uint8Array(data)).trim();
      } catch {
        return '';
      }
    }
    return '';
  }

  function responseError(response) {
    const bodyText = decodeResponseBody(response);
    if (!bodyText) return `HTTP ${response.status} ${response.statusText || ''}`.trim();

    try {
      const parsed = JSON.parse(bodyText);
      const detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail || parsed);
      return `HTTP ${response.status}: ${detail}`;
    } catch {
      return `HTTP ${response.status}: ${bodyText.slice(0, 500)}`;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function requestArrayBuffer(url, options = {}) {
    return new Promise((resolve, reject) => {
      const retryStatuses = new Set(options.retryStatuses || []);
      const retries = Number(options.retries || 0);

      function attempt(attemptIndex) {
        const request = GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          headers: options.headers || {},
          data: options.data,
          responseType: 'arraybuffer',
          timeout: options.timeout || 240000,
          onload: async (response) => {
            activeRequests.delete(request);
            if (response.status >= 200 && response.status < 300) {
              resolve(response);
              return;
            }

            if (!stopRequested && attemptIndex < retries && retryStatuses.has(response.status)) {
              setStatus(`Kokoro returned ${response.status}; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
              await wait(900 * (attemptIndex + 1));
              attempt(attemptIndex + 1);
              return;
            }

            reject(new Error(responseError(response)));
          },
          onerror: async () => {
            activeRequests.delete(request);
            if (!stopRequested && attemptIndex < retries) {
              setStatus(`Network hiccup; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
              await wait(900 * (attemptIndex + 1));
              attempt(attemptIndex + 1);
              return;
            }

            reject(new Error('Network request failed.'));
          },
          ontimeout: async () => {
            activeRequests.delete(request);
            if (!stopRequested && attemptIndex < retries) {
              setStatus(`Kokoro timed out; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
              await wait(900 * (attemptIndex + 1));
              attempt(attemptIndex + 1);
              return;
            }

            reject(new Error('Kokoro request timed out.'));
          },
          onabort: () => {
            activeRequests.delete(request);
            reject(new Error('Kokoro request aborted.'));
          },
        });
        activeRequests.add(request);
      }

      attempt(0);
    });
  }

  function validateAudioResponse(response) {
    const contentType = String(
      response.responseHeaders?.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || ''
    ).toLowerCase();

    const buffer = response.response;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error('Kokoro returned a non-binary response.');
    }

    if (!contentType.includes('audio/')) {
      throw new Error(`Kokoro returned ${contentType || 'unknown content type'} instead of audio: ${decodeResponseBody(response).slice(0, 300)}`);
    }

    if (buffer.byteLength < 44) {
      throw new Error(`Kokoro returned incomplete audio (${buffer.byteLength} bytes).`);
    }

    const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
    const signature = String.fromCharCode(...header);
    if (!signature.startsWith('RIFF') || signature.slice(8, 12) !== 'WAVE') {
      throw new Error(`Kokoro returned audio data that is not WAV (${signature}).`);
    }
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safeSeconds / 60);
    const wholeSeconds = Math.floor(safeSeconds % 60);
    return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  }

  function currentPlaybackOffset() {
    if (!activeAudioBuffer) return 0;
    if (isPlaybackPaused || !activeAudioContext) {
      return Math.min(playbackOffset, activeAudioBuffer.duration);
    }

    return Math.min(
      playbackOffset + (activeAudioContext.currentTime - playbackStartedAt),
      activeAudioBuffer.duration,
    );
  }

  function updatePlaybackControls() {
    const hasAudio = Boolean(activeAudioBuffer);
    const duration = activeAudioBuffer?.duration || 0;
    const offset = currentPlaybackOffset();

    [replayButtonEl, backButtonEl, pauseButtonEl, forwardButtonEl, progressInputEl].forEach((control) => {
      if (control) control.disabled = !hasAudio;
    });

    if (pauseButtonEl) {
      pauseButtonEl.textContent = isPlaybackPaused ? 'Play' : 'Pause';
    }

    if (progressInputEl && duration > 0 && document.activeElement !== progressInputEl) {
      progressInputEl.value = String(Math.round((offset / duration) * 1000));
    }

    if (timeEl) {
      timeEl.textContent = `${formatTime(offset)} / ${formatTime(duration)}`;
    }
  }

  function startPlaybackTimer() {
    clearInterval(playbackTimer);
    playbackTimer = setInterval(updatePlaybackControls, 250);
    updatePlaybackControls();
  }

  function stopActiveSource() {
    if (activeAudioSource) {
      activeAudioSource.onended = null;
      try {
        activeAudioSource.stop();
      } catch {
        // Already stopped.
      }
      activeAudioSource.disconnect();
      activeAudioSource = null;
    }
  }

  function cleanupAudio(resolvePlayback = false) {
    stopActiveSource();
    clearInterval(playbackTimer);
    playbackTimer = null;
    isPlaybackPaused = true;

    if (activeAudioBuffer) {
      playbackOffset = Math.min(playbackOffset, activeAudioBuffer.duration);
    } else {
      playbackOffset = 0;
    }

    updatePlaybackControls();

    if (resolvePlayback && activePlaybackResolve) {
      activePlaybackResolve();
      activePlaybackResolve = null;
    }
  }

  function getAudioContext() {
    if (activeAudioContext && activeAudioContext.state !== 'closed') {
      return activeAudioContext;
    }

    const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
    const AudioContextConstructor = (
      pageWindow.AudioContext
      || pageWindow.webkitAudioContext
      || window.AudioContext
      || window.webkitAudioContext
    );

    if (!AudioContextConstructor) {
      throw new Error('This browser does not expose Web Audio playback.');
    }

    activeAudioContext = new AudioContextConstructor();
    return activeAudioContext;
  }

  async function unlockAudioPlayback() {
    const context = getAudioContext();
    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  async function decodeAudioBuffer(context, buffer) {
    const audioBytes = buffer.slice(0);

    return new Promise((resolve, reject) => {
      const maybePromise = context.decodeAudioData(
        audioBytes,
        resolve,
        reject,
      );

      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
  }

  function combineAudioBuffers(buffers) {
    const context = getAudioContext();
    const validBuffers = buffers.filter(Boolean);

    if (!validBuffers.length) {
      throw new Error('No audio buffers were generated.');
    }

    if (validBuffers.length === 1) {
      return validBuffers[0];
    }

    const sampleRate = validBuffers[0].sampleRate;
    const channelCount = Math.max(...validBuffers.map((buffer) => buffer.numberOfChannels));
    const totalLength = validBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const combined = context.createBuffer(channelCount, totalLength, sampleRate);
    let writeOffset = 0;

    for (const buffer of validBuffers) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
        combined.getChannelData(channel).set(input, writeOffset);
      }
      writeOffset += buffer.length;
    }

    return combined;
  }

  function startCurrentAudio(offset = playbackOffset) {
    if (!activeAudioBuffer) {
      setStatus('No generated audio to play yet.', 'warn');
      return;
    }

    const context = getAudioContext();
    const safeOffset = Math.min(Math.max(0, offset), activeAudioBuffer.duration);

    stopActiveSource();
    playbackOffset = safeOffset;

    if (playbackOffset >= activeAudioBuffer.duration) {
      isPlaybackPaused = true;
      updatePlaybackControls();
      return;
    }

    const source = context.createBufferSource();
    activeAudioSource = source;
    source.buffer = activeAudioBuffer;
    source.connect(context.destination);
    playbackStartedAt = context.currentTime;
    isPlaybackPaused = false;

    source.onended = () => {
      if (activeAudioSource !== source) return;

      source.disconnect();
      activeAudioSource = null;
      playbackOffset = activeAudioBuffer?.duration || 0;
      isPlaybackPaused = true;
      clearInterval(playbackTimer);
      playbackTimer = null;
      updatePlaybackControls();

      if (activePlaybackResolve) {
        activePlaybackResolve();
        activePlaybackResolve = null;
      }
    };

    source.start(0, playbackOffset);
    startPlaybackTimer();
  }

  async function playCombinedAudio(audioBuffer) {
    cleanupAudio(true);
    await unlockAudioPlayback();
    activeAudioBuffer = audioBuffer;
    playbackOffset = 0;

    return new Promise((resolve, reject) => {
      try {
        activePlaybackResolve = resolve;
        startCurrentAudio(0);
      } catch (error) {
        cleanupAudio(true);
        reject(new Error(`Audio playback failed: ${error.message}`));
      }
    });
  }

  async function synthesizeSpeech(text, index = 0, total = 1) {
    const url = `${cleanBaseUrl(settings.apiUrl)}/v1/audio/speech`;
    const response = await requestArrayBuffer(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': settings.apiKey,
      },
      data: JSON.stringify({
        text,
        voice: settings.voice,
        speed: Number(settings.speed) || 1,
      }),
      retries: 3,
      retryStatuses: [429, 500, 502, 503, 504],
    });

    validateAudioResponse(response);
    setStatus(total > 1 ? `Decoding ${index + 1}/${total}...` : 'Decoding audio...', 'info');
    return decodeAudioBuffer(getAudioContext(), response.response);
  }

  async function synthesizeChunks(chunks) {
    const audioBuffers = [];

    for (let index = 0; index < chunks.length; index += 1) {
      if (stopRequested) break;
      setStatus(`Generating ${index + 1}/${chunks.length} (${chunks[index].length} chars)...`, 'info');
      audioBuffers.push(await synthesizeSpeech(chunks[index], index, chunks.length));
    }

    return audioBuffers;
  }

  async function speakText(text, label = 'text') {
    const prepared = textForSpeech(text);
    if (!prepared) {
      setStatus(`No ${label} to read.`, 'warn');
      return;
    }

    saveFromControls();
    stopRequested = false;
    const chunks = splitTextForRequests(prepared);

    if (!chunks.length) {
      setStatus(`No ${label} to read.`, 'warn');
      return;
    }

    try {
      setControlsBusy(true);
      setStatus(chunks.length > 1
        ? `Generating ${chunks.length} parts, one request at a time...`
        : `Generating audio (${prepared.length} chars)...`, 'info');
      const audioBuffer = combineAudioBuffers(await synthesizeChunks(chunks));

      if (stopRequested) {
        setStatus('Stopped.', 'warn');
      } else {
        setStatus('Playing audio...', 'ok');
        await playCombinedAudio(audioBuffer);
        if (!stopRequested) setStatus('Finished playback. Use the controller to replay or seek.', 'ok');
      }
    } catch (error) {
      if (stopRequested) setStatus('Stopped.', 'warn');
      else setStatus(`TTS failed: ${error.message}`, 'error');
    } finally {
      setControlsBusy(false);
    }
  }

  function stopPlayback() {
    stopRequested = true;
    cleanupAudio(true);
    for (const request of activeRequests) {
      if (request && typeof request.abort === 'function') request.abort();
    }
    activeRequests.clear();
    setControlsBusy(false);
    setStatus('Stopped.', 'warn');
  }

  function setControlsBusy(busy) {
    root?.querySelectorAll('[data-action="read-latest"], [data-action="read-selected"], [data-action="read-box"], [data-action="test"]')
      .forEach((button) => {
        button.disabled = busy;
      });
  }

  async function replayLastAudio() {
    if (!activeAudioBuffer) {
      setStatus('No generated audio to replay yet.', 'warn');
      return;
    }

    await unlockAudioPlayback();
    playbackOffset = 0;
    startCurrentAudio(0);
    setStatus('Replaying last audio.', 'ok');
  }

  async function togglePause() {
    if (!activeAudioBuffer) {
      setStatus('No generated audio to control yet.', 'warn');
      return;
    }

    if (isPlaybackPaused) {
      await unlockAudioPlayback();
      startCurrentAudio(playbackOffset >= activeAudioBuffer.duration ? 0 : playbackOffset);
      setStatus('Playback resumed.', 'ok');
      return;
    }

    playbackOffset = currentPlaybackOffset();
    stopActiveSource();
    isPlaybackPaused = true;
    updatePlaybackControls();
    setStatus('Playback paused.', 'warn');
  }

  async function seekRelative(seconds) {
    if (!activeAudioBuffer) {
      setStatus('No generated audio to seek yet.', 'warn');
      return;
    }

    const wasPaused = isPlaybackPaused;
    const nextOffset = Math.min(
      Math.max(0, currentPlaybackOffset() + seconds),
      activeAudioBuffer.duration,
    );

    playbackOffset = nextOffset;
    if (wasPaused) {
      stopActiveSource();
      updatePlaybackControls();
    } else {
      await unlockAudioPlayback();
      startCurrentAudio(nextOffset);
    }
  }

  async function seekToProgress(value) {
    if (!activeAudioBuffer) return;

    const wasPaused = isPlaybackPaused;
    const ratio = Math.min(Math.max(Number(value) || 0, 0), 1000) / 1000;
    playbackOffset = activeAudioBuffer.duration * ratio;

    if (wasPaused) {
      stopActiveSource();
      updatePlaybackControls();
    } else {
      await unlockAudioPlayback();
      startCurrentAudio(playbackOffset);
    }
  }

  async function prepareAudioFromClick() {
    try {
      await unlockAudioPlayback();
      return true;
    } catch (error) {
      setStatus(`Audio setup failed: ${error.message}`, 'error');
      return false;
    }
  }

  function saveFromControls() {
    settings.apiUrl = cleanBaseUrl(apiUrlInputEl.value);
    settings.apiKey = apiKeyInputEl.value.trim();
    settings.voice = voiceSelectEl.value || DEFAULTS.voice;
    settings.speed = Number(speedInputEl.value) || DEFAULTS.speed;
    settings.manualText = manualTextEl.value;
    saveSettings();
  }

  async function loadVoices() {
    if (voicesLoaded) return;
    setStatus('Loading voices...', 'info');

    try {
      saveFromControls();
      const response = await requestArrayBuffer(`${cleanBaseUrl(settings.apiUrl)}/v1/voices`, {
        method: 'GET',
        headers: {
          'X-API-Key': settings.apiKey,
        },
        timeout: 30000,
      });

      const text = decodeResponseBody(response);
      const payload = JSON.parse(text);
      const voices = Object.entries(payload.voices || {})
        .filter(([voiceId, info]) => {
          const gender = String(info?.gender || '').toLowerCase();
          return gender !== 'male' && !voiceId.startsWith('am_') && !voiceId.startsWith('bm_');
        });

      if (!voices.length) throw new Error('No voices returned.');

      voiceSelectEl.textContent = '';
      for (const [voiceId, info] of voices) {
        const option = document.createElement('option');
        option.value = voiceId;
        option.textContent = `${voiceId} - ${info.accent || 'English'} ${info.gender || ''}`.trim();
        voiceSelectEl.append(option);
      }

      if (!voices.some(([voiceId]) => voiceId === settings.voice)) {
        settings.voice = payload.default_voice && voices.some(([voiceId]) => voiceId === payload.default_voice)
          ? payload.default_voice
          : voices[0][0];
      }

      voiceSelectEl.value = settings.voice;
      voicesLoaded = true;
      saveSettings();
      setStatus(`Loaded ${voices.length} female voices.`, 'ok');
    } catch (error) {
      setStatus(`Voice load failed: ${error.message}`, 'error');
    }
  }

  function createButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    return button;
  }

  function createField(label, input) {
    const wrapper = document.createElement('label');
    wrapper.className = 'kokoro-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrapper.append(span, input);
    return wrapper;
  }

  function buildUi() {
    if (document.getElementById(ROOT_ID)) return;

    GM_addStyle(`
      #${ROOT_ID} {
        position: fixed;
        z-index: 2147483647;
        right: 14px;
        bottom: 14px;
        width: min(360px, calc(100vw - 28px));
        max-height: min(720px, calc(100vh - 28px));
        overflow: auto;
        color: #f8fafc;
        background: #111827;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.35;
      }

      #${ROOT_ID} * {
        box-sizing: border-box;
      }

      #${ROOT_ID}.kokoro-collapsed .kokoro-body {
        display: none;
      }

      #${ROOT_ID} .kokoro-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        cursor: move;
      }

      #${ROOT_ID} .kokoro-title {
        font-weight: 700;
        letter-spacing: 0;
      }

      #${ROOT_ID} .kokoro-body {
        display: grid;
        gap: 10px;
        padding: 12px;
      }

      #${ROOT_ID} .kokoro-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      #${ROOT_ID} .kokoro-controller {
        display: grid;
        gap: 8px;
        padding: 8px;
        border: 1px solid rgba(255, 255, 255, 0.11);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.05);
      }

      #${ROOT_ID} .kokoro-controls {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }

      #${ROOT_ID} .kokoro-progress-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
      }

      #${ROOT_ID} .kokoro-time {
        min-width: 72px;
        color: #cbd5e1;
        font-size: 12px;
        text-align: right;
        white-space: nowrap;
      }

      #${ROOT_ID} button,
      #${ROOT_ID} input,
      #${ROOT_ID} select,
      #${ROOT_ID} textarea {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        color: #f8fafc;
        background: #1f2937;
        font: inherit;
      }

      #${ROOT_ID} button {
        min-height: 34px;
        padding: 7px 9px;
        font-weight: 650;
        cursor: pointer;
      }

      #${ROOT_ID} button:hover {
        background: #374151;
      }

      #${ROOT_ID} button:disabled {
        cursor: wait;
        opacity: 0.55;
      }

      #${ROOT_ID} button[data-action="stop"] {
        background: #7f1d1d;
      }

      #${ROOT_ID} input,
      #${ROOT_ID} select {
        min-height: 32px;
        padding: 6px 8px;
      }

      #${ROOT_ID} input[type="range"] {
        min-height: 24px;
        padding: 0;
      }

      #${ROOT_ID} textarea {
        min-height: 118px;
        resize: vertical;
        padding: 8px;
        white-space: pre-wrap;
      }

      #${ROOT_ID} .kokoro-field {
        display: grid;
        gap: 4px;
      }

      #${ROOT_ID} .kokoro-field > span {
        color: #cbd5e1;
        font-size: 12px;
      }

      #${ROOT_ID} .kokoro-advanced {
        display: grid;
        gap: 8px;
      }

      #${ROOT_ID} .kokoro-advanced > summary {
        min-height: 32px;
        padding: 7px 9px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        color: #f8fafc;
        background: #1f2937;
        font-weight: 650;
        cursor: pointer;
      }

      #${ROOT_ID} .kokoro-advanced-body {
        display: grid;
        gap: 8px;
      }

      #${ROOT_ID} .kokoro-status,
      #${ROOT_ID} .kokoro-preview {
        min-height: 32px;
        padding: 8px;
        border: 1px solid rgba(255, 255, 255, 0.11);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: #dbeafe;
        overflow-wrap: anywhere;
      }

      #${ROOT_ID} .kokoro-status[data-tone="ok"] {
        color: #bbf7d0;
      }

      #${ROOT_ID} .kokoro-status[data-tone="warn"] {
        color: #fde68a;
      }

      #${ROOT_ID} .kokoro-status[data-tone="error"] {
        color: #fecaca;
      }
    `);

    root = document.createElement('section');
    root.id = ROOT_ID;
    root.className = settings.collapsed ? 'kokoro-collapsed' : '';

    const header = document.createElement('div');
    header.className = 'kokoro-header';

    const title = document.createElement('div');
    title.className = 'kokoro-title';
    title.textContent = 'Kokoro TTS';

    const collapseButton = createButton(settings.collapsed ? 'Open' : 'Hide', 'collapse');
    collapseButton.style.width = '72px';
    header.append(title, collapseButton);

    const body = document.createElement('div');
    body.className = 'kokoro-body';

    const actionRow = document.createElement('div');
    actionRow.className = 'kokoro-row';
    actionRow.append(
      createButton('Read latest', 'read-latest'),
      createButton('Read selected', 'read-selected'),
    );

    const actionRow2 = document.createElement('div');
    actionRow2.className = 'kokoro-row';
    actionRow2.append(
      createButton('Read box', 'read-box'),
      createButton('Stop', 'stop'),
    );

    const controller = document.createElement('div');
    controller.className = 'kokoro-controller';

    const controlButtons = document.createElement('div');
    controlButtons.className = 'kokoro-controls';

    replayButtonEl = createButton('Replay', 'replay');
    backButtonEl = createButton('-10s', 'back');
    pauseButtonEl = createButton('Play', 'pause');
    forwardButtonEl = createButton('+10s', 'forward');
    controlButtons.append(replayButtonEl, backButtonEl, pauseButtonEl, forwardButtonEl);

    const progressRow = document.createElement('div');
    progressRow.className = 'kokoro-progress-row';

    progressInputEl = document.createElement('input');
    progressInputEl.type = 'range';
    progressInputEl.min = '0';
    progressInputEl.max = '1000';
    progressInputEl.step = '1';
    progressInputEl.value = '0';

    timeEl = document.createElement('div');
    timeEl.className = 'kokoro-time';
    timeEl.textContent = '0:00 / 0:00';

    progressRow.append(progressInputEl, timeEl);
    controller.append(controlButtons, progressRow);
    updatePlaybackControls();

    manualTextEl = document.createElement('textarea');
    manualTextEl.placeholder = 'Paste text here, including **bold**, *italics*, timestamps, narration, and dialogue.';
    manualTextEl.value = settings.manualText || '';

    apiUrlInputEl = document.createElement('input');
    apiUrlInputEl.value = settings.apiUrl;
    apiUrlInputEl.autocomplete = 'off';

    apiKeyInputEl = document.createElement('input');
    apiKeyInputEl.value = settings.apiKey;
    apiKeyInputEl.type = 'password';
    apiKeyInputEl.autocomplete = 'off';

    voiceSelectEl = document.createElement('select');
    const defaultVoiceOption = document.createElement('option');
    defaultVoiceOption.value = settings.voice;
    defaultVoiceOption.textContent = settings.voice;
    voiceSelectEl.append(defaultVoiceOption);

    speedInputEl = document.createElement('input');
    speedInputEl.type = 'number';
    speedInputEl.min = '0.5';
    speedInputEl.max = '2';
    speedInputEl.step = '0.05';
    speedInputEl.value = String(settings.speed);

    const settingsRow = document.createElement('div');
    settingsRow.className = 'kokoro-row';
    settingsRow.append(
      createField('Voice', voiceSelectEl),
      createField('Speed', speedInputEl),
    );

    const advanced = document.createElement('details');
    advanced.className = 'kokoro-advanced';

    const advancedSummary = document.createElement('summary');
    advancedSummary.textContent = 'Advanced';

    const advancedBody = document.createElement('div');
    advancedBody.className = 'kokoro-advanced-body';
    advancedBody.append(
      createField('API URL', apiUrlInputEl),
      createField('API key', apiKeyInputEl),
    );

    advanced.append(advancedSummary, advancedBody);

    statusEl = document.createElement('div');
    statusEl.className = 'kokoro-status';
    statusEl.dataset.tone = 'info';
    statusEl.textContent = 'Ready.';

    latestPreviewEl = document.createElement('div');
    latestPreviewEl.className = 'kokoro-preview';
    latestPreviewEl.textContent = 'Latest message preview appears here.';

    body.append(
      actionRow,
      actionRow2,
      controller,
      createField('Text box', manualTextEl),
      settingsRow,
      advanced,
      statusEl,
      latestPreviewEl,
    );

    root.append(header, body);
    document.body.append(root);

    root.addEventListener('pointerdown', (event) => {
      if (event.target?.closest?.('[data-action="read-selected"]')) {
        event.preventDefault();
      }
    });

    root.addEventListener('input', () => {
      saveFromControls();
    });

    root.addEventListener('change', () => {
      saveFromControls();
    });

    progressInputEl.addEventListener('input', () => {
      if (!activeAudioBuffer) return;

      const ratio = Math.min(Math.max(Number(progressInputEl.value) || 0, 0), 1000) / 1000;
      const offset = activeAudioBuffer.duration * ratio;
      if (timeEl) {
        timeEl.textContent = `${formatTime(offset)} / ${formatTime(activeAudioBuffer.duration)}`;
      }
    });

    progressInputEl.addEventListener('change', async () => {
      await seekToProgress(progressInputEl.value);
    });

    root.addEventListener('click', async (event) => {
      const button = event.target?.closest?.('button[data-action]');
      if (!button) return;

      const action = button.dataset.action;
      if (action === 'collapse') {
        settings.collapsed = !settings.collapsed;
        root.classList.toggle('kokoro-collapsed', settings.collapsed);
        button.textContent = settings.collapsed ? 'Open' : 'Hide';
        saveSettings();
        return;
      }

      if (action === 'stop') {
        stopPlayback();
        return;
      }

      if (action === 'replay') {
        if (!await prepareAudioFromClick()) return;
        await replayLastAudio();
        return;
      }

      if (action === 'pause') {
        if (!await prepareAudioFromClick()) return;
        await togglePause();
        return;
      }

      if (action === 'back') {
        await seekRelative(-10);
        return;
      }

      if (action === 'forward') {
        await seekRelative(10);
        return;
      }

      if (action === 'read-latest') {
        if (!await prepareAudioFromClick()) return;
        await loadVoices();
        await speakText(findLatestText(), 'latest message');
        return;
      }

      if (action === 'read-selected') {
        if (!await prepareAudioFromClick()) return;
        await loadVoices();
        await speakText(getCurrentSelectionText(), 'selected text');
        return;
      }

      if (action === 'read-box') {
        if (!await prepareAudioFromClick()) return;
        await loadVoices();
        await speakText(manualTextEl.value, 'text box');
      }
    });

    document.addEventListener('selectionchange', updateRememberedSelection);
    document.addEventListener('keyup', updateRememberedSelection, true);
    document.addEventListener('pointerup', updateRememberedSelection, true);

    setInterval(() => {
      if (!settings.collapsed) findLatestText();
    }, 2500);

    findLatestText();
    loadVoices();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUi, { once: true });
  } else {
    buildUi();
  }
})();
