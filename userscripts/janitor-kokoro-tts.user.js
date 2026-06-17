// ==UserScript==
// @name         JanitorAI Voice Studio
// @namespace    <namespace if any>
// @version      1.6.13
// @description  Read JanitorAI messages, selected text, or typed text with a private Kokoro Cloud Run API.
// @author       Kaushik Paul
// @match        https://janitorai.com/chats/*
// @match        https://www.janitorai.com/chats/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=janitorai.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      www.url
// @connect      url
// @connect      openrouter.ai
// @connect      api.xiaomimimo.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULTS = {
    apiUrl: '<Url>',
    apiKey: '<password>',
    voice: 'af_heart',
    speed: 1,
    collapsed: false,
    manualText: '',
    useByok: false,
    byokProvider: 'openrouter',
    useOpenRouter: false,
    openRouterApiKey: '',
    mimoApiKey: '',
    cloudRunVoice: 'af_heart',
    openRouterVoice: 'af_heart',
    mimoVoice: 'Chloe',
  };

  const OPENROUTER_API_KEY_OVERRIDE = '';
  const OPENROUTER_MODEL = 'hexgrad/kokoro-82m';
  const OPENROUTER_SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
  const OPENROUTER_VOICES = [
    ['af_heart', 'American female'],
    ['af_alloy', 'American female'],
    ['af_aoede', 'American female'],
    ['af_bella', 'American female'],
    ['af_jessica', 'American female'],
    ['af_kore', 'American female'],
    ['af_nicole', 'American female'],
    ['af_nova', 'American female'],
    ['af_river', 'American female'],
    ['af_sarah', 'American female'],
    ['af_sky', 'American female'],
    ['bf_alice', 'British female'],
    ['bf_emma', 'British female'],
    ['bf_isabella', 'British female'],
    ['bf_lily', 'British female'],
  ];
  const MIMO_API_KEY_OVERRIDE = '';
  const MIMO_MODEL = 'mimo-v2.5-tts';
  const MIMO_CHAT_COMPLETIONS_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
  const MIMO_VOICES = [
    ['冰糖', 'Chinese female'],
    ['茉莉', 'Chinese female'],
    ['Mia', 'English female'],
    ['Chloe', 'English female'],
  ];
  const DEFAULT_STYLE_INSTRUCTION = [
    'Perform as an expressive adult-fiction audiobook narrator with a warm, intimate voice and a natural, slightly brisk storytelling pace.',
    'Interpret italic action, timestamps, setting lines, and inner monologue as narration with smooth forward momentum; interpret character-labeled quoted lines as spoken dialogue with clear emotional intent.',
    'Use natural emotional variation, restrained pauses, and feeling so the delivery sounds vivid and embodied, but do not elongate narration pauses or add audible breathing sounds, sound effects, or extra dramatization.',
    'Treat mature fictional story content as narrative material, preserve the text exactly, and continue the performance without adding commentary.',
  ].join(' ');

  const STORAGE_KEY = 'janitor-kokoro-tts-settings-v2';
  const ROOT_ID = 'kokoro-tts-root';
  const USER_SCRIPT_VERSION = '1.6.13';
  const MAX_TEXT_CHARS = 5900;
  const REQUEST_CHUNK_CHARS = 600;
  const MAX_PARALLEL_REQUESTS = 4;
  const ACTION_TEXT_PATTERN = /^(copy|edit|copy\s*edit|copyedit|delete|regenerate|continue|retry|swipe|report|more|less)$/i;
  const CLOUD_RUN_BACKEND = 'cloudRun';
  const PANEL_EDGE_MARGIN = 8;

  let settings = loadSettings();
  let root;
  let statusEl;
  let latestPreviewEl;
  let manualTextEl;
  let voiceSelectEl;
  let speedInputEl;
  let apiUrlInputEl;
  let apiKeyInputEl;
  let apiUrlFieldEl;
  let apiKeyFieldEl;
  let byokToggleEl;
  let byokRowEl;
  let providerToggleEl;
  let openRouterProviderButtonEl;
  let mimoProviderButtonEl;
  let openRouterApiKeyInputEl;
  let mimoApiKeyInputEl;
  let openRouterApiKeyFieldEl;
  let mimoApiKeyFieldEl;
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
  let isProgressSeeking = false;
  const activeRequests = new Set();
  let stopRequested = false;
  let voicesLoaded = false;
  let voiceListLoadToken = 0;
  let activeVoiceBackend = voiceBackendFromSettings(settings);
  let panelDragState = null;

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const loaded = {
        ...DEFAULTS,
        ...parsed,
      };
      if (parsed.useOpenRouter && parsed.useByok === undefined) {
        loaded.useByok = true;
        loaded.byokProvider = 'openrouter';
      }
      loaded.byokProvider = loaded.byokProvider === 'mimo' ? 'mimo' : 'openrouter';
      loaded.useOpenRouter = Boolean(loaded.useByok && loaded.byokProvider === 'openrouter');
      loaded.cloudRunVoice = loaded.cloudRunVoice || (!loaded.useByok ? loaded.voice : DEFAULTS.cloudRunVoice);
      loaded.openRouterVoice = loaded.openRouterVoice || (loaded.useByok && loaded.byokProvider === 'openrouter' ? loaded.voice : DEFAULTS.openRouterVoice);
      loaded.mimoVoice = loaded.mimoVoice || (loaded.useByok && loaded.byokProvider === 'mimo' ? loaded.voice : DEFAULTS.mimoVoice);
      loaded.voice = voiceForBackend(loaded, voiceBackendFromSettings(loaded));
      return loaded;
    } catch {
      return { ...DEFAULTS };
    }
  }

  function voiceBackendFromSettings(value = settings) {
    if (!value.useByok) return CLOUD_RUN_BACKEND;
    return value.byokProvider === 'mimo' ? 'mimo' : 'openrouter';
  }

  function voiceForBackend(value, backend) {
    if (backend === 'mimo') return value.mimoVoice || DEFAULTS.mimoVoice;
    if (backend === 'openrouter') return value.openRouterVoice || DEFAULTS.openRouterVoice;
    return value.cloudRunVoice || value.voice || DEFAULTS.cloudRunVoice;
  }

  function rememberVoiceForBackend(backend, voice) {
    const nextVoice = voice || DEFAULTS.voice;
    if (backend === 'mimo') {
      settings.mimoVoice = nextVoice;
    } else if (backend === 'openrouter') {
      settings.openRouterVoice = nextVoice;
    } else {
      settings.cloudRunVoice = nextVoice;
    }
    settings.voice = nextVoice;
  }

  function showRememberedVoice(backend) {
    if (!voiceSelectEl) return;

    const voice = voiceForBackend(settings, backend);
    voiceSelectEl.textContent = '';
    const option = document.createElement('option');
    option.value = voice;
    option.textContent = voice;
    voiceSelectEl.append(option);
    voiceSelectEl.value = voice;
    activeVoiceBackend = backend;
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function cleanBaseUrl(value) {
    return String(value || DEFAULTS.apiUrl).trim().replace(/\/+$/, '');
  }

  function openRouterApiKey() {
    return String(OPENROUTER_API_KEY_OVERRIDE || settings.openRouterApiKey || '').trim();
  }

  function mimoApiKey() {
    return String(MIMO_API_KEY_OVERRIDE || settings.mimoApiKey || '').trim();
  }

  function activeByokProvider() {
    return settings.byokProvider === 'mimo' ? 'mimo' : 'openrouter';
  }

  function useOpenRouterByok() {
    return Boolean(settings.useByok && activeByokProvider() === 'openrouter');
  }

  function useMimoByok() {
    return Boolean(settings.useByok && activeByokProvider() === 'mimo');
  }

  function effectiveStyleInstruction() {
    return DEFAULT_STYLE_INSTRUCTION;
  }

  function effectivePlaybackRate() {
    if (!settings.useByok) return 1;
    return Math.min(Math.max(Number(settings.speed) || 1, 0.25), 4);
  }

  function activePlaybackRate() {
    return Number(activeAudioSource?.playbackRate?.value) || effectivePlaybackRate();
  }

  function setStatus(message, tone = 'info') {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  }

  function setTextPreview(label, value) {
    if (!latestPreviewEl) return;

    const text = textForSpeech(value);
    if (!text) {
      latestPreviewEl.textContent = `${label}: no readable text.`;
      return;
    }

    const preview = text.length > 180 ? `${text.slice(0, 180)}...` : text;
    latestPreviewEl.textContent = `${label} (${text.length} chars): ${preview}`;
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
      setTextPreview('Selected text saved', text);
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

  function isElementNode(node) {
    return Boolean(node && node.nodeType === 1);
  }

  function pageDocument() {
    return (typeof unsafeWindow === 'object' && unsafeWindow.document) || document;
  }

  function queryPageAll(selector) {
    return Array.from(pageDocument().querySelectorAll(selector));
  }

  function visible(element) {
    if (!isElementNode(element)) return false;
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
      'JanitorAI Voice Studio',
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
      'selection saved',
      'loading voices',
    ].map(escapeRegExp).join('|'), 'i');
  }

  function isUsefulMessageText(text) {
    const value = normalizeText(text);
    if (value.length < 8) return false;
    if (value.length > MAX_TEXT_CHARS * 2) return false;
    if (value.length < 240 && uiTextNoisePattern().test(value)) return false;
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
      '[class*="messageControls" i]',
      '[class*="messageFooter" i]',
      '[class*="messageAvatar" i]',
      '[class*="messageName" i]',
      '[class*="nameContainer" i]',
      '[class*="nameText" i]',
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
      '[class*="messageName" i]',
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
    const body = wrapper.matches?.('[class*="messageBody" i]')
      ? wrapper
      : wrapper.querySelector('[class*="messageBody" i]');
    if (!body) return wrapper;

    const content = body.matches?.('.css-17apud6')
      ? body
      : body.querySelector(':scope > .css-17apud6, .css-17apud6');
    if (content) return content;

    const bodyChildren = Array.from(body.children).filter((child) => (
      !child.matches([
        '[class*="messageName" i]',
        '[class*="nameContainer" i]',
        '[class*="nameText" i]',
        '[class*="messageFooter" i]',
        '[class*="messageAvatar" i]',
        '[class*="messageControls" i]',
      ].join(','))
    ));

    return bodyChildren.at(-1) || body;
  }

  function messageNameText(wrapper) {
    return normalizeText(wrapper.querySelector?.('[class*="nameText" i]')?.textContent || '');
  }

  function stripLeadingMessageName(value, wrapper) {
    const name = messageNameText(wrapper);
    const text = cleanExtractedMessageText(value);
    if (!name || !text) return text;

    const lines = text.split('\n');
    if (normalizeText(lines[0]) !== name) return text;

    return cleanExtractedMessageText(lines.slice(1).join('\n'));
  }

  function readableTextFromMessageNode(node) {
    if (!node) return '';

    const clone = node.cloneNode(true);
    clone.querySelectorAll([
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
      '[class*="messageName" i]',
      '[class*="nameContainer" i]',
      '[class*="nameText" i]',
      '[aria-label*="copy" i]',
      '[aria-label*="edit" i]',
    ].join(',')).forEach((element) => element.remove());

    return cleanExtractedMessageText(clone.innerText || clone.textContent || '');
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
    const readableText = stripLeadingMessageName(readableTextFromMessageNode(content), wrapper);
    if (readableText) return readableText;

    const text = stripLeadingMessageName(markdownFromNode(content), wrapper);
    const name = messageNameText(wrapper);

    if (name && text === name) return '';
    if (text) return text;

    return stripLeadingMessageName(visibleTextWithoutControls(wrapper), wrapper);
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

  function latestIndexedBotText() {
    const indexedRows = queryPageAll('[data-index]').filter((element) => (
      isElementNode(element)
      && !element.closest(`#${ROOT_ID}`)
    ));
    const botRows = indexedRows.map((element, order) => {
      const index = Number.parseInt(element.getAttribute('data-index') || '', 10);
      const hasBotAvatar = Boolean(element.querySelector('img[src*="/bot-avatars/"], img[alt="Character Icon"]'));
      const hasDelete = Boolean(element.querySelector('button[aria-label="Delete"]'));
      const text = messageWrapperText(element);

      return {
        element,
        order,
        index,
        hasBotAvatar,
        hasDelete,
        text,
      };
    }).filter((row) => (
      Number.isFinite(row.index)
      && row.hasBotAvatar
      && !row.hasDelete
    ));
    const readableRows = botRows.filter((row) => isUsefulMessageText(row.text));
    const latest = readableRows.sort((left, right) => (
      right.index - left.index
      || right.order - left.order
    ))[0];

    if (latest) return latest.text;

    return '';
  }

  function findLatestRenderedBotText() {
    const indexedBotText = latestIndexedBotText();
    if (indexedBotText) return indexedBotText;

    const avatarWrappers = queryPageAll(
      'img[src*="/bot-avatars/"], img[alt="Character Icon"]',
    ).map(messageWrapperFromAvatar).filter(Boolean);

    const wrappers = Array.from(new Set([
      ...avatarWrappers,
      ...queryPageAll([
      'li[class*="messageDisplayWrapper" i]',
      '[class*="messageDisplayWrapper" i]',
      '[data-index]',
      ].join(',')),
    ])).filter((element) => (
      isElementNode(element)
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
    const wrapper = element.closest?.('li[class*="messageDisplayWrapper" i], [class*="messageDisplayWrapper" i]');
    if (element.querySelector?.('button[aria-label="Delete"]') || wrapper?.querySelector?.('button[aria-label="Delete"]')) return true;
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
        for (const element of queryPageAll(selector)) {
          if (!isElementNode(element)) continue;
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
        console.warn('JanitorAI Voice Studio selector ignored:', error);
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
      setTextPreview('Latest bot message', renderedBotText);
      return renderedBotText;
    }

    const candidates = collectCandidates();

    if (!candidates.length) {
      latestPreviewEl.textContent = 'No latest bot message found. Use selected text or the text box.';
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
    setTextPreview('Latest message candidate', text);
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
    if (!prepared) return [];

    const chunks = [];
    let current = '';

    function pushCurrent() {
      const text = current.trim();
      if (text) chunks.push(text);
      current = '';
    }

    for (const paragraph of prepared.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean)) {
      if (paragraph.length > REQUEST_CHUNK_CHARS) {
        pushCurrent();
        chunks.push(...splitLongText(paragraph, REQUEST_CHUNK_CHARS));
      } else if (!current) {
        current = paragraph;
      } else if (`${current}\n\n${paragraph}`.length <= REQUEST_CHUNK_CHARS) {
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
      const detail = typeof parsed.detail === 'string'
        ? parsed.detail
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : JSON.stringify(parsed.detail || parsed.error || parsed);
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
      const serviceName = options.serviceName || 'Kokoro';

      function attempt(attemptIndex) {
        const request = GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          headers: options.headers || {},
          data: options.data,
          responseType: 'arraybuffer',
          timeout: options.timeout || 240000,
          fetch: Boolean(options.useFetchTransport),
          onload: async (response) => {
            activeRequests.delete(request);
            if (response.status >= 200 && response.status < 300) {
              resolve(response);
              return;
            }

            if (!stopRequested && attemptIndex < retries && retryStatuses.has(response.status)) {
              setStatus(`${serviceName} returned ${response.status}; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
              await wait(900 * (attemptIndex + 1));
              attempt(attemptIndex + 1);
              return;
            }

            reject(new Error(responseError(response)));
          },
          onerror: async () => {
            activeRequests.delete(request);
            if (!stopRequested && attemptIndex < retries) {
              setStatus(`${serviceName} network hiccup; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
              await wait(900 * (attemptIndex + 1));
              attempt(attemptIndex + 1);
              return;
            }

            reject(new Error('Network request failed.'));
          },
          ontimeout: async () => {
            activeRequests.delete(request);
            if (!stopRequested && attemptIndex < retries) {
              setStatus(`${serviceName} timed out; retrying ${attemptIndex + 1}/${retries}...`, 'warn');
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

  function validateAudioResponse(response, options = {}) {
    const serviceName = options.serviceName || 'Kokoro';
    const requireWav = options.requireWav !== false;
    const contentType = String(
      response.responseHeaders?.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || ''
    ).toLowerCase();

    const buffer = response.response;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error(`${serviceName} returned a non-binary response.`);
    }

    if (!contentType.includes('audio/') && !contentType.includes('application/octet-stream')) {
      throw new Error(`${serviceName} returned ${contentType || 'unknown content type'} instead of audio: ${decodeResponseBody(response).slice(0, 300)}`);
    }

    if (buffer.byteLength < 44) {
      throw new Error(`${serviceName} returned incomplete audio (${buffer.byteLength} bytes).`);
    }

    if (!requireWav) {
      return;
    }

    const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
    const signature = String.fromCharCode(...header);
    if (!signature.startsWith('RIFF') || signature.slice(8, 12) !== 'WAVE') {
      throw new Error(`${serviceName} returned audio data that is not WAV (${signature}).`);
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
      playbackOffset + ((activeAudioContext.currentTime - playbackStartedAt) * activePlaybackRate()),
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

    if (progressInputEl && duration > 0 && !isProgressSeeking) {
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

  function syncActivePlaybackRate() {
    if (!activeAudioSource || !activeAudioContext || isPlaybackPaused) return;

    playbackOffset = currentPlaybackOffset();
    playbackStartedAt = activeAudioContext.currentTime;
    activeAudioSource.playbackRate.value = effectivePlaybackRate();
    updatePlaybackControls();
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

  function readAscii(bytes, offset, length) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
  }

  function writeAscii(bytes, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  }

  function parseWav(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    if (bytes.length < 44 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
      throw new Error('Audio chunk is not a RIFF/WAVE file.');
    }

    let fmtBytes = null;
    let formatKey = '';
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;

    while (offset + 8 <= bytes.length) {
      const chunkId = readAscii(bytes, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;

      if (chunkDataOffset + chunkSize > bytes.length) {
        throw new Error(`Invalid WAV ${chunkId.trim() || 'chunk'} size.`);
      }

      if (chunkId === 'fmt ') {
        if (chunkSize < 16) throw new Error('WAV fmt chunk is too small.');
        fmtBytes = bytes.slice(chunkDataOffset, chunkDataOffset + chunkSize);
        formatKey = [
          view.getUint16(chunkDataOffset, true),
          view.getUint16(chunkDataOffset + 2, true),
          view.getUint32(chunkDataOffset + 4, true),
          view.getUint16(chunkDataOffset + 12, true),
          view.getUint16(chunkDataOffset + 14, true),
        ].join(':');
      } else if (chunkId === 'data') {
        dataOffset = chunkDataOffset;
        dataSize = chunkSize;
      }

      offset = chunkDataOffset + chunkSize + (chunkSize % 2);
    }

    if (!fmtBytes || dataOffset < 0) {
      throw new Error('WAV chunk is missing fmt or data.');
    }

    return { bytes, fmtBytes, formatKey, dataOffset, dataSize };
  }

  function combineWavBuffers(buffers) {
    const validBuffers = buffers.filter(Boolean);

    if (!validBuffers.length) {
      throw new Error('No audio buffers were generated.');
    }

    if (validBuffers.length === 1) {
      return validBuffers[0];
    }

    const parsedBuffers = validBuffers.map(parseWav);
    const first = parsedBuffers[0];

    if (!parsedBuffers.every((item) => item.formatKey === first.formatKey)) {
      throw new Error('Kokoro returned WAV chunks with different audio formats.');
    }

    const fmtSize = first.fmtBytes.byteLength;
    const fmtPad = fmtSize % 2;
    const dataSize = parsedBuffers.reduce((sum, item) => sum + item.dataSize, 0);
    const dataPad = dataSize % 2;
    const fileSize = 12 + 8 + fmtSize + fmtPad + 8 + dataSize + dataPad;
    const output = new ArrayBuffer(fileSize);
    const bytes = new Uint8Array(output);
    const view = new DataView(output);
    let offset = 0;

    writeAscii(bytes, offset, 'RIFF');
    offset += 4;
    view.setUint32(offset, fileSize - 8, true);
    offset += 4;
    writeAscii(bytes, offset, 'WAVE');
    offset += 4;
    writeAscii(bytes, offset, 'fmt ');
    offset += 4;
    view.setUint32(offset, fmtSize, true);
    offset += 4;
    bytes.set(first.fmtBytes, offset);
    offset += fmtSize + fmtPad;
    writeAscii(bytes, offset, 'data');
    offset += 4;
    view.setUint32(offset, dataSize, true);
    offset += 4;

    for (const item of parsedBuffers) {
      bytes.set(item.bytes.subarray(item.dataOffset, item.dataOffset + item.dataSize), offset);
      offset += item.dataSize;
    }

    return output;
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
      if (latestPreviewEl) latestPreviewEl.textContent = 'Playback: no generated audio to play yet.';
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
    source.playbackRate.value = effectivePlaybackRate();
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

  function speechUrl(index, total, batchId) {
    const url = new URL(`${cleanBaseUrl(settings.apiUrl)}/v1/audio/speech`);
    if (total > 1) {
      url.searchParams.set('batch', batchId);
      url.searchParams.set('chunk', String(index + 1));
      url.searchParams.set('total', String(total));
    }
    return url.toString();
  }

  async function synthesizeSpeech(text, index = 0, total = 1, batchId = '') {
    const url = speechUrl(index, total, batchId);
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
      useFetchTransport: true,
    });

    validateAudioResponse(response);
    setStatus(total > 1 ? `Received ${index + 1}/${total}.` : 'Received audio.', 'info');
    return response.response;
  }

  async function synthesizeOpenRouterSpeech(text) {
    const apiKey = openRouterApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key is required when OpenRouter is selected.');
    }

    const response = await requestArrayBuffer(OPENROUTER_SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'JanitorAI Voice Studio',
      },
      data: JSON.stringify({
        model: OPENROUTER_MODEL,
        input: text,
        voice: settings.voice,
        response_format: 'mp3',
      }),
      retries: 2,
      retryStatuses: [429, 500, 502, 503, 504, 524, 529],
      serviceName: 'OpenRouter',
      timeout: 240000,
      useFetchTransport: true,
    });

    validateAudioResponse(response, { serviceName: 'OpenRouter', requireWav: false });
    setStatus('Received OpenRouter audio.', 'info');
    return response.response;
  }

  function base64ToArrayBuffer(value) {
    const cleanValue = String(value || '').replace(/^data:[^,]+,/u, '');
    const binary = atob(cleanValue);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function extractMimoAudio(response) {
    const body = decodeResponseBody(response);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Mimo returned invalid JSON: ${body.slice(0, 300)}`);
    }

    const audioData = payload?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      const detail = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 300);
      throw new Error(`Mimo response did not include audio data: ${detail}`);
    }

    const audioBuffer = base64ToArrayBuffer(audioData);
    validateAudioResponse({
      response: audioBuffer,
      responseHeaders: 'content-type: audio/wav',
    }, { serviceName: 'Mimo' });
    return audioBuffer;
  }

  async function synthesizeMimoSpeech(text) {
    const apiKey = mimoApiKey();
    if (!apiKey) {
      throw new Error('Mimo API key is required when Mimo is selected.');
    }

    const styleInstruction = effectiveStyleInstruction();
    const messages = [];
    if (styleInstruction) {
      messages.push({
        role: 'user',
        content: styleInstruction,
      });
    }
    messages.push({
      role: 'assistant',
      content: text,
    });

    const response = await requestArrayBuffer(MIMO_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        model: MIMO_MODEL,
        messages,
        audio: {
          format: 'wav',
          voice: settings.voice,
        },
      }),
      retries: 2,
      retryStatuses: [429, 500, 502, 503, 504],
      serviceName: 'Mimo',
      timeout: 240000,
      useFetchTransport: true,
    });

    setStatus('Received Mimo audio.', 'info');
    return extractMimoAudio(response);
  }

  async function synthesizeChunks(chunks) {
    if (chunks.length === 1) {
      return [await synthesizeSpeech(chunks[0], 0, 1)];
    }

    const wavBuffers = new Array(chunks.length);
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    setStatus(`Generating ${chunks.length} small parts (${MAX_PARALLEL_REQUESTS} at a time)...`, 'info');

    for (let start = 0; start < chunks.length && !stopRequested; start += MAX_PARALLEL_REQUESTS) {
      const wave = chunks.slice(start, start + MAX_PARALLEL_REQUESTS);
      const first = start + 1;
      const last = start + wave.length;
      setStatus(`Generating ${first}-${last}/${chunks.length} in parallel...`, 'info');

      await Promise.all(wave.map(async (chunk, waveIndex) => {
        const index = start + waveIndex;
        wavBuffers[index] = await synthesizeSpeech(chunk, index, chunks.length, batchId);
      }));
    }

    return wavBuffers;
  }

  async function decodeGeneratedAudio(wavBuffers) {
    try {
      setStatus(wavBuffers.length > 1 ? 'Combining WAV chunks...' : 'Preparing audio...', 'info');
      const combinedWav = combineWavBuffers(wavBuffers);
      setStatus('Decoding audio...', 'info');
      return await decodeAudioBuffer(getAudioContext(), combinedWav);
    } catch (error) {
      setStatus(`Fast combine failed; decoding chunks separately: ${error.message}`, 'warn');
      const decodedBuffers = [];
      for (let index = 0; index < wavBuffers.length; index += 1) {
        if (stopRequested) break;
        setStatus(`Decoding ${index + 1}/${wavBuffers.length}...`, 'info');
        decodedBuffers.push(await decodeAudioBuffer(getAudioContext(), wavBuffers[index]));
      }
      return combineAudioBuffers(decodedBuffers);
    }
  }

  async function decodeOpenRouterAudio(audioBytes) {
    setStatus('Decoding OpenRouter audio...', 'info');
    return await decodeAudioBuffer(getAudioContext(), audioBytes);
  }

  async function decodeMimoAudio(audioBytes) {
    setStatus('Decoding Mimo audio...', 'info');
    return await decodeAudioBuffer(getAudioContext(), audioBytes);
  }

  async function speakText(text, label = 'text') {
    const prepared = textForSpeech(text);
    if (!prepared) {
      if (latestPreviewEl) latestPreviewEl.textContent = `No ${label} to read.`;
      return;
    }

    saveFromControls();
    stopRequested = false;
    const usingOpenRouter = useOpenRouterByok();
    const usingMimo = useMimoByok();

    if (usingOpenRouter && !openRouterApiKey()) {
      setStatus('OpenRouter API key is required when OpenRouter is selected.', 'error');
      return;
    }

    if (usingMimo && !mimoApiKey()) {
      setStatus('Mimo API key is required when Mimo is selected.', 'error');
      return;
    }

    if (usingOpenRouter) {
      try {
        setControlsBusy(true);
        setStatus(`Generating OpenRouter audio (${prepared.length} chars)...`, 'info');
        const audioBuffer = await decodeOpenRouterAudio(await synthesizeOpenRouterSpeech(prepared));

        if (stopRequested) {
          setStatus('Stopped.', 'warn');
        } else {
          await playCombinedAudio(audioBuffer);
        }
      } catch (error) {
        if (stopRequested) setStatus('Stopped.', 'warn');
        else setStatus(`OpenRouter TTS failed: ${error.message}`, 'error');
      } finally {
        setControlsBusy(false);
      }
      return;
    }

    if (usingMimo) {
      try {
        setControlsBusy(true);
        setStatus(`Generating Mimo audio (${prepared.length} chars)...`, 'info');
        const audioBuffer = await decodeMimoAudio(await synthesizeMimoSpeech(prepared));

        if (stopRequested) {
          setStatus('Stopped.', 'warn');
        } else {
          await playCombinedAudio(audioBuffer);
        }
      } catch (error) {
        if (stopRequested) setStatus('Stopped.', 'warn');
        else setStatus(`Mimo TTS failed: ${error.message}`, 'error');
      } finally {
        setControlsBusy(false);
      }
      return;
    }

    const chunks = splitTextForRequests(prepared);

    if (!chunks.length) {
      if (latestPreviewEl) latestPreviewEl.textContent = `No ${label} to read.`;
      return;
    }

    try {
      setControlsBusy(true);
      setStatus(chunks.length > 1
        ? `Generating ${chunks.length} small parts, ${Math.min(MAX_PARALLEL_REQUESTS, chunks.length)} at a time...`
        : `Generating audio (${prepared.length} chars)...`, 'info');
      const audioBuffer = await decodeGeneratedAudio(await synthesizeChunks(chunks));

      if (stopRequested) {
        setStatus('Stopped.', 'warn');
      } else {
        await playCombinedAudio(audioBuffer);
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
      if (latestPreviewEl) latestPreviewEl.textContent = 'Playback: no generated audio to replay yet.';
      return;
    }

    await unlockAudioPlayback();
    playbackOffset = 0;
    startCurrentAudio(0);
  }

  async function togglePause() {
    if (!activeAudioBuffer) {
      if (latestPreviewEl) latestPreviewEl.textContent = 'Playback: no generated audio to control yet.';
      return;
    }

    if (isPlaybackPaused) {
      await unlockAudioPlayback();
      startCurrentAudio(playbackOffset >= activeAudioBuffer.duration ? 0 : playbackOffset);
      return;
    }

    playbackOffset = currentPlaybackOffset();
    stopActiveSource();
    isPlaybackPaused = true;
    updatePlaybackControls();
  }

  async function seekRelative(seconds) {
    if (!activeAudioBuffer) {
      if (latestPreviewEl) latestPreviewEl.textContent = 'Playback: no generated audio to seek yet.';
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
      if (latestPreviewEl) latestPreviewEl.textContent = `Audio setup failed: ${error.message}`;
      return false;
    }
  }

  function saveFromControls() {
    if (voiceSelectEl) {
      rememberVoiceForBackend(activeVoiceBackend, voiceSelectEl.value || voiceForBackend(settings, activeVoiceBackend));
    }
    settings.apiUrl = cleanBaseUrl(apiUrlInputEl.value);
    settings.apiKey = apiKeyInputEl.value.trim();
    settings.useByok = Boolean(byokToggleEl?.checked);
    settings.byokProvider = activeByokProvider();
    settings.useOpenRouter = useOpenRouterByok();
    settings.openRouterApiKey = openRouterApiKeyInputEl?.value.trim() || '';
    settings.mimoApiKey = mimoApiKeyInputEl?.value.trim() || '';
    settings.voice = voiceForBackend(settings, voiceBackendFromSettings(settings));
    settings.speed = Number(speedInputEl.value) || DEFAULTS.speed;
    settings.manualText = manualTextEl.value;
    saveSettings();
    syncActivePlaybackRate();
  }

  async function loadVoices(loadToken = ++voiceListLoadToken) {
    if (settings.useByok) return;
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
      if (settings.useByok || loadToken !== voiceListLoadToken) return;

      voiceSelectEl.textContent = '';
      for (const [voiceId, info] of voices) {
        const option = document.createElement('option');
        option.value = voiceId;
        option.textContent = `${voiceId} - ${info.accent || 'English'} ${info.gender || ''}`.trim();
        voiceSelectEl.append(option);
      }

      const rememberedVoice = voiceForBackend(settings, CLOUD_RUN_BACKEND);
      const selectedVoice = voices.some(([voiceId]) => voiceId === rememberedVoice)
        ? rememberedVoice
        : payload.default_voice && voices.some(([voiceId]) => voiceId === payload.default_voice)
          ? payload.default_voice
          : voices[0][0];

      rememberVoiceForBackend(CLOUD_RUN_BACKEND, selectedVoice);
      voiceSelectEl.value = selectedVoice;
      activeVoiceBackend = CLOUD_RUN_BACKEND;
      voicesLoaded = true;
      saveSettings();
      setStatus(`Loaded ${voices.length} female voices.`, 'ok');
    } catch (error) {
      setStatus(`Voice load failed: ${error.message}`, 'error');
    }
  }

  function selectVoiceFromList(voices, fallbackVoice, backend) {
    const currentVoice = voiceForBackend(settings, backend);
    const selectedVoice = voices.some(([voiceId]) => voiceId === currentVoice)
      ? currentVoice
      : fallbackVoice;
    rememberVoiceForBackend(backend, selectedVoice);
    voiceSelectEl.value = selectedVoice;
    activeVoiceBackend = backend;
    voicesLoaded = false;
    saveSettings();
  }

  function loadOpenRouterVoices() {
    if (!voiceSelectEl) return;

    voiceSelectEl.textContent = '';

    for (const [voiceId, label] of OPENROUTER_VOICES) {
      const option = document.createElement('option');
      option.value = voiceId;
      option.textContent = `${voiceId} - ${label}`;
      voiceSelectEl.append(option);
    }

    selectVoiceFromList(OPENROUTER_VOICES, DEFAULTS.openRouterVoice, 'openrouter');
  }

  function loadMimoVoices() {
    if (!voiceSelectEl) return;

    voiceSelectEl.textContent = '';

    for (const [voiceId, label] of MIMO_VOICES) {
      const option = document.createElement('option');
      option.value = voiceId;
      option.textContent = `${voiceId} - ${label}`;
      voiceSelectEl.append(option);
    }

    selectVoiceFromList(MIMO_VOICES, DEFAULTS.mimoVoice, 'mimo');
  }

  function loadProviderVoices() {
    const loadToken = ++voiceListLoadToken;
    if (!settings.useByok) {
      voicesLoaded = false;
      settings.voice = voiceForBackend(settings, CLOUD_RUN_BACKEND);
      showRememberedVoice(CLOUD_RUN_BACKEND);
      saveSettings();
      loadVoices(loadToken);
      return;
    }

    if (activeByokProvider() === 'mimo') {
      loadMimoVoices();
      return;
    }

    loadOpenRouterVoices();
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

  function createCheckboxField(label, input) {
    const wrapper = document.createElement('label');
    wrapper.className = 'kokoro-toggle-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrapper.append(input, span);
    return wrapper;
  }

  function updateByokProviderControls() {
    const provider = activeByokProvider();
    const byokEnabled = Boolean(settings.useByok);
    if (byokRowEl) {
      byokRowEl.dataset.byokEnabled = String(byokEnabled);
    }
    if (providerToggleEl) {
      providerToggleEl.hidden = !byokEnabled;
    }
    if (openRouterProviderButtonEl) {
      openRouterProviderButtonEl.dataset.active = String(provider === 'openrouter');
      openRouterProviderButtonEl.disabled = false;
    }
    if (mimoProviderButtonEl) {
      mimoProviderButtonEl.dataset.active = String(provider === 'mimo');
      mimoProviderButtonEl.disabled = false;
    }
    if (openRouterApiKeyFieldEl) {
      openRouterApiKeyFieldEl.hidden = !byokEnabled || provider !== 'openrouter';
    }
    if (mimoApiKeyFieldEl) {
      mimoApiKeyFieldEl.hidden = !byokEnabled || provider !== 'mimo';
    }
    if (apiUrlFieldEl) {
      apiUrlFieldEl.hidden = byokEnabled;
    }
    if (apiKeyFieldEl) {
      apiKeyFieldEl.hidden = byokEnabled;
    }
    if (openRouterApiKeyInputEl) {
      openRouterApiKeyInputEl.disabled = Boolean(OPENROUTER_API_KEY_OVERRIDE);
    }
    if (mimoApiKeyInputEl) {
      mimoApiKeyInputEl.disabled = Boolean(MIMO_API_KEY_OVERRIDE);
    }
  }

  function setByokProvider(provider) {
    settings.byokProvider = provider === 'mimo' ? 'mimo' : 'openrouter';
    settings.useOpenRouter = useOpenRouterByok();
    settings.voice = voiceForBackend(settings, voiceBackendFromSettings(settings));
    updateByokProviderControls();
    saveSettings();
    if (settings.useByok) {
      loadProviderVoices();
      setStatus(`${settings.byokProvider === 'mimo' ? 'Mimo' : 'OpenRouter'} BYOK selected.`, 'info');
    } else {
      setStatus(`${settings.byokProvider === 'mimo' ? 'Mimo' : 'OpenRouter'} selected for BYOK.`, 'info');
    }
  }

  function clampedPanelPosition(left, top) {
    const rect = root?.getBoundingClientRect?.();
    const width = rect?.width || 360;
    const height = rect?.height || 80;
    const maxLeft = Math.max(PANEL_EDGE_MARGIN, window.innerWidth - width - PANEL_EDGE_MARGIN);
    const maxTop = Math.max(PANEL_EDGE_MARGIN, window.innerHeight - Math.min(height, window.innerHeight - (PANEL_EDGE_MARGIN * 2)) - PANEL_EDGE_MARGIN);

    return {
      left: Math.min(Math.max(Number(left) || PANEL_EDGE_MARGIN, PANEL_EDGE_MARGIN), maxLeft),
      top: Math.min(Math.max(Number(top) || PANEL_EDGE_MARGIN, PANEL_EDGE_MARGIN), maxTop),
    };
  }

  function setPanelPosition(left, top) {
    if (!root) return;

    const position = clampedPanelPosition(left, top);
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function keepPanelInViewport() {
    if (!root || !root.style.left || !root.style.top) return;

    const rect = root.getBoundingClientRect();
    setPanelPosition(rect.left, rect.top);
  }

  function startPanelDrag(event, handle) {
    if (!root) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target?.closest?.('button, input, select, textarea, summary, a')) return;

    const rect = root.getBoundingClientRect();
    panelDragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    root.dataset.dragging = 'true';
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function dragPanel(event) {
    if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;
    setPanelPosition(event.clientX - panelDragState.offsetX, event.clientY - panelDragState.offsetY);
    event.preventDefault();
  }

  function stopPanelDrag(event, handle) {
    if (!panelDragState || event.pointerId !== panelDragState.pointerId) return;

    handle.releasePointerCapture?.(event.pointerId);
    const rect = root.getBoundingClientRect();
    panelDragState = null;
    delete root.dataset.dragging;
    setPanelPosition(rect.left, rect.top);
    event.preventDefault();
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

      #${ROOT_ID}[data-dragging="true"] {
        user-select: none;
      }

      #${ROOT_ID} .kokoro-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        cursor: move;
        touch-action: none;
        user-select: none;
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

      #${ROOT_ID} .kokoro-field[hidden] {
        display: none;
      }

      #${ROOT_ID} .kokoro-field > span {
        color: #cbd5e1;
        font-size: 12px;
      }

      #${ROOT_ID} .kokoro-toggle-field {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        color: #cbd5e1;
        font-size: 12px;
      }

      #${ROOT_ID} .kokoro-toggle-field input {
        width: auto;
        min-height: auto;
        margin: 0;
      }

      #${ROOT_ID} .kokoro-byok-row {
        display: grid;
        grid-template-columns: minmax(108px, 0.7fr) minmax(200px, 1.3fr);
        align-items: center;
        gap: 8px;
      }

      #${ROOT_ID} .kokoro-byok-row[data-byok-enabled="false"] {
        grid-template-columns: minmax(0, 1fr);
      }

      #${ROOT_ID} .kokoro-provider-toggle {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 2px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.05);
      }

      #${ROOT_ID} .kokoro-provider-toggle[hidden] {
        display: none;
      }

      #${ROOT_ID} .kokoro-provider-toggle button {
        min-height: 28px;
        padding: 5px 7px;
        border: 0;
        background: transparent;
        font-size: 12px;
        white-space: nowrap;
      }

      #${ROOT_ID} .kokoro-provider-toggle button[data-active="true"] {
        background: #2563eb;
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
    title.textContent = 'JanitorAI Voice Studio';

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

    byokToggleEl = document.createElement('input');
    byokToggleEl.type = 'checkbox';
    byokToggleEl.checked = Boolean(settings.useByok);

    providerToggleEl = document.createElement('div');
    providerToggleEl.className = 'kokoro-provider-toggle';

    openRouterProviderButtonEl = createButton('OpenRouter', 'provider-openrouter');
    mimoProviderButtonEl = createButton('Mimo', 'provider-mimo');
    providerToggleEl.append(openRouterProviderButtonEl, mimoProviderButtonEl);

    openRouterApiKeyInputEl = document.createElement('input');
    openRouterApiKeyInputEl.value = settings.openRouterApiKey || '';
    openRouterApiKeyInputEl.type = 'password';
    openRouterApiKeyInputEl.autocomplete = 'off';
    openRouterApiKeyInputEl.placeholder = OPENROUTER_API_KEY_OVERRIDE
      ? 'Using script key override'
      : 'sk-or-...';
    openRouterApiKeyInputEl.disabled = Boolean(OPENROUTER_API_KEY_OVERRIDE);

    mimoApiKeyInputEl = document.createElement('input');
    mimoApiKeyInputEl.value = settings.mimoApiKey || '';
    mimoApiKeyInputEl.type = 'password';
    mimoApiKeyInputEl.autocomplete = 'off';
    mimoApiKeyInputEl.placeholder = MIMO_API_KEY_OVERRIDE
      ? 'Using script key override'
      : 'Mimo API key';
    mimoApiKeyInputEl.disabled = Boolean(MIMO_API_KEY_OVERRIDE);

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
    byokRowEl = document.createElement('div');
    byokRowEl.className = 'kokoro-byok-row';
    byokRowEl.append(
      createCheckboxField('Use BYOK', byokToggleEl),
      providerToggleEl,
    );
    openRouterApiKeyFieldEl = createField('OpenRouter API key', openRouterApiKeyInputEl);
    mimoApiKeyFieldEl = createField('Mimo API key', mimoApiKeyInputEl);
    apiUrlFieldEl = createField('API URL', apiUrlInputEl);
    apiKeyFieldEl = createField('API key', apiKeyInputEl);
    advancedBody.append(
      byokRowEl,
      openRouterApiKeyFieldEl,
      mimoApiKeyFieldEl,
      apiUrlFieldEl,
      apiKeyFieldEl,
    );

    advanced.append(advancedSummary, advancedBody);

    statusEl = document.createElement('div');
    statusEl.className = 'kokoro-status';
    statusEl.dataset.tone = 'info';
    statusEl.textContent = `Ready. v${USER_SCRIPT_VERSION}`;

    latestPreviewEl = document.createElement('div');
    latestPreviewEl.className = 'kokoro-preview';
    latestPreviewEl.textContent = 'Text preview and character count appear here.';

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

    header.addEventListener('pointerdown', (event) => {
      startPanelDrag(event, header);
    });

    header.addEventListener('pointermove', dragPanel);

    header.addEventListener('pointerup', (event) => {
      stopPanelDrag(event, header);
    });

    header.addEventListener('pointercancel', (event) => {
      stopPanelDrag(event, header);
    });

    window.addEventListener('resize', keepPanelInViewport);

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

    updateByokProviderControls();

    byokToggleEl.addEventListener('change', () => {
      saveFromControls();
      updateByokProviderControls();
      loadProviderVoices();
      setStatus(settings.useByok
        ? `${activeByokProvider() === 'mimo' ? 'Mimo' : 'OpenRouter'} BYOK selected.`
        : 'Kokoro API selected.', 'info');
    });

    openRouterProviderButtonEl.addEventListener('click', () => {
      saveFromControls();
      setByokProvider('openrouter');
    });

    mimoProviderButtonEl.addEventListener('click', () => {
      saveFromControls();
      setByokProvider('mimo');
    });

    progressInputEl.addEventListener('pointerdown', () => {
      isProgressSeeking = true;
    });

    progressInputEl.addEventListener('input', () => {
      if (!activeAudioBuffer) return;

      isProgressSeeking = true;
      const ratio = Math.min(Math.max(Number(progressInputEl.value) || 0, 0), 1000) / 1000;
      const offset = activeAudioBuffer.duration * ratio;
      if (timeEl) {
        timeEl.textContent = `${formatTime(offset)} / ${formatTime(activeAudioBuffer.duration)}`;
      }
    });

    progressInputEl.addEventListener('change', async () => {
      await seekToProgress(progressInputEl.value);
      isProgressSeeking = false;
      updatePlaybackControls();
    });

    progressInputEl.addEventListener('pointerup', async () => {
      if (activeAudioBuffer) {
        await seekToProgress(progressInputEl.value);
      }
      isProgressSeeking = false;
      updatePlaybackControls();
    });

    progressInputEl.addEventListener('blur', () => {
      isProgressSeeking = false;
      updatePlaybackControls();
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
        requestAnimationFrame(keepPanelInViewport);
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
        saveFromControls();
        if (!settings.useByok) await loadVoices();
        await speakText(findLatestText(), 'latest message');
        return;
      }

      if (action === 'read-selected') {
        if (!await prepareAudioFromClick()) return;
        saveFromControls();
        if (!settings.useByok) await loadVoices();
        const text = getCurrentSelectionText();
        setTextPreview('Selected text', text);
        await speakText(text, 'selected text');
        return;
      }

      if (action === 'read-box') {
        if (!await prepareAudioFromClick()) return;
        saveFromControls();
        if (!settings.useByok) await loadVoices();
        setTextPreview('Text box', manualTextEl.value);
        await speakText(manualTextEl.value, 'text box');
      }
    });

    document.addEventListener('selectionchange', updateRememberedSelection);
    document.addEventListener('keyup', updateRememberedSelection, true);
    document.addEventListener('pointerup', updateRememberedSelection, true);

    findLatestText();
    loadProviderVoices();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUi, { once: true });
  } else {
    buildUi();
  }
})();
