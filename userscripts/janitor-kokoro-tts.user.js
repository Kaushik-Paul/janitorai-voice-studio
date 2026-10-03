// ==UserScript==
// @name         JanitorAI Voice Studio
// @namespace    https://www.kokoro.pp.ua/
// @version      1.8.0
// @description  Read JanitorAI messages, selected text, or typed text with Kokoro Hugging Face Spaces or BYOK providers.
// @author       Kaushik Paul
// @match        https://janitorai.com/chats/*
// @match        https://www.janitorai.com/chats/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=janitorai.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      apicpu.kokoro.pp.ua
// @connect      apizero.kokoro.pp.ua
// @connect      openrouter.ai
// @connect      api.xiaomimimo.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULTS = {
    cpuApiKey: '',
    hfToken: '',
    useGpu: false,
    voice: 'af_heart',
    speed: 1,
    collapsed: false,
    manualText: '',
    useByok: false,
    byokProvider: 'openrouter',
    useOpenRouter: false,
    openRouterApiKey: 'sk-',
    mimoApiKey: 'sk-',
    kokoroVoice: 'af_heart',
    openRouterVoice: 'af_heart',
    mimoVoice: 'Chloe',
    panelWidth: null,
    panelHeight: null,
    panelLeft: null,
    panelTop: null,
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
  const USER_SCRIPT_VERSION = '1.8.0';
  const MAX_TEXT_CHARS = 5900;
  const ACTION_TEXT_PATTERN = /^(copy|edit|copy\s*edit|copyedit|delete|regenerate|continue|retry|swipe|report|more|less)$/i;
  const KOKORO_BACKEND = 'kokoro';
  const CPU_SPACE_URL = 'https://apicpu.kokoro.pp.ua';
  const GPU_SPACE_URL = 'https://apizero.kokoro.pp.ua';
  const GRADIO_API_PREFIX = '/gradio_api';
  const PANEL_EDGE_MARGIN = 8;
  const PANEL_DEFAULT_WIDTH = 380;
  const PANEL_MIN_WIDTH = 280;
  const PANEL_MIN_HEIGHT = 220;
  const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  let settings = loadSettings();
  let root;
  let statusEl;
  let latestPreviewEl;
  let manualTextEl;
  let voiceSelectEl;
  let speedInputEl;
  let apiKeyInputEl;
  let apiKeyFieldEl;
  let gpuToggleEl;
  let gpuToggleFieldEl;
  let hfTokenInputEl;
  let hfTokenFieldEl;
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
  let panelResizeState = null;
  let collapseButtonEl;
  let miniReadButtonEl;
  let miniStatusEl;
  let isBusy = false;
  let previewRefreshTimer = null;

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
      const legacyApiKey = parsed.apiKey === 'kokoro.pp.ua' ? '' : parsed.apiKey;
      loaded.cpuApiKey = parsed.cpuApiKey ?? legacyApiKey ?? DEFAULTS.cpuApiKey;
      loaded.hfToken = parsed.hfToken || DEFAULTS.hfToken;
      loaded.useGpu = Boolean(parsed.useGpu);
      loaded.kokoroVoice = parsed.kokoroVoice || parsed.cloudRunVoice || (!loaded.useByok ? loaded.voice : DEFAULTS.kokoroVoice);
      loaded.openRouterVoice = loaded.openRouterVoice || (loaded.useByok && loaded.byokProvider === 'openrouter' ? loaded.voice : DEFAULTS.openRouterVoice);
      loaded.mimoVoice = loaded.mimoVoice || (loaded.useByok && loaded.byokProvider === 'mimo' ? loaded.voice : DEFAULTS.mimoVoice);
      loaded.voice = voiceForBackend(loaded, voiceBackendFromSettings(loaded));
      delete loaded.apiUrl;
      delete loaded.apiKey;
      delete loaded.cloudRunVoice;
      return loaded;
    } catch {
      return { ...DEFAULTS };
    }
  }

  function voiceBackendFromSettings(value = settings) {
    if (!value.useByok) return KOKORO_BACKEND;
    return value.byokProvider === 'mimo' ? 'mimo' : 'openrouter';
  }

  function voiceForBackend(value, backend) {
    if (backend === 'mimo') return value.mimoVoice || DEFAULTS.mimoVoice;
    if (backend === 'openrouter') return value.openRouterVoice || DEFAULTS.openRouterVoice;
    return value.kokoroVoice || value.voice || DEFAULTS.kokoroVoice;
  }

  function rememberVoiceForBackend(backend, voice) {
    const nextVoice = voice || DEFAULTS.voice;
    if (backend === 'mimo') {
      settings.mimoVoice = nextVoice;
    } else if (backend === 'openrouter') {
      settings.openRouterVoice = nextVoice;
    } else {
      settings.kokoroVoice = nextVoice;
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
    if (miniStatusEl) {
      miniStatusEl.textContent = message;
      miniStatusEl.title = message;
      miniStatusEl.dataset.tone = tone;
    }
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.tone = tone;
  }

  function setTextPreview(label, value, fromLatestScan = false) {
    if (!latestPreviewEl) return;
    latestPreviewEl.dataset.auto = String(fromLatestScan);

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
      setTextPreview('Latest bot message', renderedBotText, true);
      return renderedBotText;
    }

    const candidates = collectCandidates();

    if (!candidates.length) {
      latestPreviewEl.textContent = 'No latest bot message found. Use selected text or the text box.';
      latestPreviewEl.dataset.auto = 'true';
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
    setTextPreview('Latest message candidate', text, true);
    return text;
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

            reject(new Error(`${serviceName} request timed out.`));
          },
          onabort: () => {
            activeRequests.delete(request);
            reject(new Error(`${serviceName} request aborted.`));
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

    if (root) {
      root.style.setProperty('--kvs-progress', duration > 0 ? String(offset / duration) : '0');
    }

    updateMiniControls();
  }

  function isAudioActive() {
    return isBusy || Boolean(activeAudioSource && !isPlaybackPaused);
  }

  function updateMiniControls() {
    if (!miniReadButtonEl) return;

    const active = isAudioActive();
    miniReadButtonEl.dataset.state = active ? 'stop' : 'read';
    miniReadButtonEl.textContent = active ? '\u25A0 Stop' : '\u25B6 Read';
    miniReadButtonEl.title = active
      ? 'Stop generation and playback (Alt+Shift+S)'
      : 'Read the latest bot message (Alt+Shift+R)';
    root?.toggleAttribute('data-active', active);
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

  async function playAudio(audioBuffer) {
    cleanupAudio(true);
    await unlockAudioPlayback();
    activeAudioBuffer = audioBuffer;
    playbackOffset = 0;

    return new Promise((resolve, reject) => {
      try {
        activePlaybackResolve = () => {
          if (!stopRequested && activeAudioBuffer === audioBuffer) setStatus('Finished playing.', 'ok');
          resolve();
        };
        setStatus(`Playing ${formatTime(audioBuffer.duration)} of audio.`, 'ok');
        startCurrentAudio(0);
      } catch (error) {
        cleanupAudio(true);
        reject(new Error(`Audio playback failed: ${error.message}`));
      }
    });
  }

  function parseJsonResponse(response, serviceName) {
    const body = decodeResponseBody(response);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`${serviceName} returned invalid JSON: ${body.slice(0, 300)}`);
    }
  }

  async function synthesizeCpuSpeech(text) {
    const response = await requestArrayBuffer(`${CPU_SPACE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': settings.cpuApiKey,
      },
      data: JSON.stringify({
        text,
        voice: settings.voice,
        speed: Number(settings.speed) || 1,
      }),
      retries: 3,
      retryStatuses: [429, 500, 502, 503, 504],
      serviceName: 'Kokoro CPU Space',
      useFetchTransport: true,
    });

    validateAudioResponse(response, { serviceName: 'Kokoro CPU Space' });
    setStatus('Received CPU Space audio.', 'info');
    return response.response;
  }

  function gradioHeaders() {
    return {
      Authorization: `Bearer ${settings.hfToken}`,
      'Content-Type': 'application/json',
    };
  }

  function gradioResultFromEvents(response) {
    const body = decodeResponseBody(response);
    const blocks = body.split(/\r?\n\r?\n/u).filter(Boolean);

    for (const block of blocks) {
      const eventName = block.match(/^event:\s*([^\r\n]+)/mu)?.[1]?.trim();
      const dataText = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (eventName === 'error') {
        let detail = dataText;
        try {
          detail = JSON.parse(dataText);
        } catch {
          // Keep the server text when the error event is not JSON.
        }
        throw new Error(`ZeroGPU queue failed: ${String(detail).slice(0, 400)}`);
      }

      if (eventName === 'complete') {
        try {
          return JSON.parse(dataText);
        } catch {
          throw new Error(`ZeroGPU returned invalid completion data: ${dataText.slice(0, 300)}`);
        }
      }
    }

    throw new Error(`ZeroGPU queue ended without a completion event: ${body.slice(0, 300)}`);
  }

  function gradioFileUrl(fileData) {
    const rawUrl = String(fileData?.url || '').trim();
    if (!rawUrl) {
      throw new Error('ZeroGPU completion did not include an audio URL.');
    }

    const parsedUrl = new URL(rawUrl, `${GPU_SPACE_URL}/`);
    return new URL(`${parsedUrl.pathname}${parsedUrl.search}`, `${GPU_SPACE_URL}/`).toString();
  }

  async function synthesizeGpuSpeech(text) {
    const callEndpoint = `${GPU_SPACE_URL}${GRADIO_API_PREFIX}/call`;
    const submitResponse = await requestArrayBuffer(`${callEndpoint}/v2/synthesize_zerogpu`, {
      method: 'POST',
      headers: gradioHeaders(),
      data: JSON.stringify({
        text,
        voice: settings.voice,
        speed: Number(settings.speed) || 1,
      }),
      retries: 2,
      retryStatuses: [429, 500, 502, 503, 504],
      serviceName: 'Kokoro ZeroGPU Space',
      timeout: 240000,
      useFetchTransport: true,
    });
    const eventId = parseJsonResponse(submitResponse, 'ZeroGPU submission')?.event_id;
    if (!eventId) {
      throw new Error('ZeroGPU submission did not return an event ID.');
    }

    setStatus('Waiting in the Hugging Face ZeroGPU queue...', 'info');
    const eventResponse = await requestArrayBuffer(`${callEndpoint}/synthesize_zerogpu/${encodeURIComponent(eventId)}`, {
      headers: {
        Authorization: `Bearer ${settings.hfToken}`,
      },
      serviceName: 'Kokoro ZeroGPU Space',
      timeout: 240000,
      useFetchTransport: true,
    });
    const result = gradioResultFromEvents(eventResponse);
    const fileData = Array.isArray(result) ? result[0] : result;

    setStatus('Downloading ZeroGPU audio...', 'info');
    const audioResponse = await requestArrayBuffer(gradioFileUrl(fileData), {
      headers: {
        Authorization: `Bearer ${settings.hfToken}`,
      },
      retries: 2,
      retryStatuses: [429, 500, 502, 503, 504],
      serviceName: 'Kokoro ZeroGPU Space',
      timeout: 240000,
      useFetchTransport: true,
    });
    validateAudioResponse(audioResponse, { serviceName: 'Kokoro ZeroGPU Space' });
    setStatus('Received ZeroGPU audio.', 'info');
    return audioResponse.response;
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

  async function decodeGeneratedAudio(audioBytes, serviceName) {
    setStatus(`Decoding ${serviceName} audio...`, 'info');
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
    const usingGpu = Boolean(!settings.useByok && settings.useGpu);

    if (usingOpenRouter && !openRouterApiKey()) {
      setStatus('OpenRouter API key is required when OpenRouter is selected.', 'error');
      return;
    }

    if (usingMimo && !mimoApiKey()) {
      setStatus('Mimo API key is required when Mimo is selected.', 'error');
      return;
    }

    if (usingGpu && !settings.hfToken) {
      setStatus('Hugging Face token is required when ZeroGPU is selected.', 'error');
      return;
    }

    if (!settings.useByok && !usingGpu && !settings.cpuApiKey) {
      setStatus('CPU Space API key is required when ZeroGPU is not selected.', 'error');
      return;
    }

    if (usingOpenRouter) {
      try {
        setControlsBusy(true);
        setStatus(`Generating OpenRouter audio (${prepared.length} chars)...`, 'info');
        const audioBuffer = await decodeGeneratedAudio(
          await synthesizeOpenRouterSpeech(prepared),
          'OpenRouter',
        );

        if (stopRequested) {
          setStatus('Stopped.', 'warn');
        } else {
          await playAudio(audioBuffer);
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
        const audioBuffer = await decodeGeneratedAudio(
          await synthesizeMimoSpeech(prepared),
          'Mimo',
        );

        if (stopRequested) {
          setStatus('Stopped.', 'warn');
        } else {
          await playAudio(audioBuffer);
        }
      } catch (error) {
        if (stopRequested) setStatus('Stopped.', 'warn');
        else setStatus(`Mimo TTS failed: ${error.message}`, 'error');
      } finally {
        setControlsBusy(false);
      }
      return;
    }

    try {
      setControlsBusy(true);
      const serviceName = usingGpu ? 'ZeroGPU' : 'CPU Space';
      setStatus(`Generating ${serviceName} audio (${prepared.length} chars)...`, 'info');
      const audioBytes = usingGpu
        ? await synthesizeGpuSpeech(prepared)
        : await synthesizeCpuSpeech(prepared);
      const audioBuffer = await decodeGeneratedAudio(audioBytes, serviceName);

      if (stopRequested) {
        setStatus('Stopped.', 'warn');
      } else {
        await playAudio(audioBuffer);
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
    isBusy = Boolean(busy);
    updateMiniControls();
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
    settings.cpuApiKey = apiKeyInputEl?.value.trim() || '';
    settings.hfToken = hfTokenInputEl?.value.trim() || '';
    settings.useGpu = Boolean(gpuToggleEl?.checked);
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
      const loadingGpuVoices = settings.useGpu;
      let voices;
      let defaultVoice;

      if (loadingGpuVoices) {
        const response = await requestArrayBuffer(`${GPU_SPACE_URL}/config`, {
          headers: settings.hfToken
            ? { Authorization: `Bearer ${settings.hfToken}` }
            : {},
          serviceName: 'Kokoro ZeroGPU Space',
          timeout: 30000,
        });
        const payload = parseJsonResponse(response, 'ZeroGPU configuration');
        const voiceComponent = (payload.components || []).find((component) => (
          component.type === 'dropdown' && component.props?.label === 'Voice'
        ));
        voices = (voiceComponent?.props?.choices || [])
          .map((choice) => Array.isArray(choice) ? [choice[1], choice[0]] : [choice, choice])
          .filter(([voiceId, label]) => voiceId?.[1] === 'f' || /female/iu.test(label));
        defaultVoice = voiceComponent?.props?.value;
      } else {
        if (!settings.cpuApiKey) {
          setStatus('Enter the CPU Space API key to load voices.', 'warn');
          return;
        }
        const response = await requestArrayBuffer(`${CPU_SPACE_URL}/v1/voices`, {
          method: 'GET',
          headers: {
            'X-API-Key': settings.cpuApiKey,
          },
          serviceName: 'Kokoro CPU Space',
          timeout: 30000,
        });
        const payload = parseJsonResponse(response, 'CPU voice list');
        voices = Object.entries(payload.voices || {})
          .filter(([voiceId, info]) => {
            const gender = String(info?.gender || '').toLowerCase();
            return gender !== 'male' && !voiceId.startsWith('am_') && !voiceId.startsWith('bm_');
          })
          .map(([voiceId, info]) => [
            voiceId,
            `${voiceId} - ${info.accent || info.language || 'English'} ${info.gender || ''}`.trim(),
          ]);
        defaultVoice = payload.default_voice;
      }

      if (!voices.length) throw new Error('No voices returned.');
      if (
        settings.useByok
        || loadingGpuVoices !== settings.useGpu
        || loadToken !== voiceListLoadToken
      ) return;

      voiceSelectEl.textContent = '';
      for (const [voiceId, label] of voices) {
        const option = document.createElement('option');
        option.value = voiceId;
        option.textContent = label;
        voiceSelectEl.append(option);
      }

      const rememberedVoice = voiceForBackend(settings, KOKORO_BACKEND);
      const selectedVoice = voices.some(([voiceId]) => voiceId === rememberedVoice)
        ? rememberedVoice
        : defaultVoice && voices.some(([voiceId]) => voiceId === defaultVoice)
          ? defaultVoice
          : voices[0][0];

      rememberVoiceForBackend(KOKORO_BACKEND, selectedVoice);
      voiceSelectEl.value = selectedVoice;
      activeVoiceBackend = KOKORO_BACKEND;
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
      settings.voice = voiceForBackend(settings, KOKORO_BACKEND);
      showRememberedVoice(KOKORO_BACKEND);
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
    const gpuEnabled = Boolean(settings.useGpu);
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
    if (gpuToggleFieldEl) {
      gpuToggleFieldEl.hidden = byokEnabled;
    }
    if (apiKeyFieldEl) {
      apiKeyFieldEl.hidden = byokEnabled || gpuEnabled;
    }
    if (hfTokenFieldEl) {
      hfTokenFieldEl.hidden = byokEnabled || !gpuEnabled;
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

  function viewportLimits() {
    return {
      maxWidth: Math.max(PANEL_MIN_WIDTH, window.innerWidth - (PANEL_EDGE_MARGIN * 2)),
      maxHeight: Math.max(PANEL_MIN_HEIGHT, window.innerHeight - (PANEL_EDGE_MARGIN * 2)),
    };
  }

  function clampedPanelPosition(left, top) {
    const rect = root?.getBoundingClientRect?.();
    const width = rect?.width || PANEL_DEFAULT_WIDTH;
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

  function applyPanelSize() {
    if (!root) return;

    const { maxWidth, maxHeight } = viewportLimits();
    const width = Number(settings.panelWidth);
    const height = Number(settings.panelHeight);

    root.style.width = width
      ? `${Math.min(Math.max(width, PANEL_MIN_WIDTH), maxWidth)}px`
      : '';
    root.style.height = height && !settings.collapsed
      ? `${Math.min(Math.max(height, PANEL_MIN_HEIGHT), maxHeight)}px`
      : '';
  }

  function savePanelPosition() {
    if (!root || !root.style.left || !root.style.top) return;

    const rect = root.getBoundingClientRect();
    settings.panelLeft = Math.round(rect.left);
    settings.panelTop = Math.round(rect.top);
    saveSettings();
  }

  function keepPanelInViewport() {
    if (!root) return;

    applyPanelSize();
    if (!root.style.left || !root.style.top) return;

    const rect = root.getBoundingClientRect();
    setPanelPosition(rect.left, rect.top);
  }

  function restorePanelLayout() {
    applyPanelSize();
    if (Number.isFinite(settings.panelLeft) && Number.isFinite(settings.panelTop)) {
      setPanelPosition(settings.panelLeft, settings.panelTop);
    }
  }

  function resetPanelLayout() {
    if (!root) return;

    settings.panelWidth = null;
    settings.panelHeight = null;
    settings.panelLeft = null;
    settings.panelTop = null;
    saveSettings();
    ['left', 'top', 'right', 'bottom', 'width', 'height'].forEach((property) => {
      root.style.removeProperty(property);
    });
    setStatus('Panel size and position reset.', 'info');
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
    savePanelPosition();
    event.preventDefault();
  }

  function startPanelResize(event, handle) {
    if (!root) return;
    if (event.button !== undefined && event.button !== 0) return;

    const rect = root.getBoundingClientRect();
    panelResizeState = {
      pointerId: event.pointerId,
      direction: handle.dataset.resize,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    };
    root.dataset.resizing = 'true';
    setPanelPosition(rect.left, rect.top);
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function resizePanel(event) {
    const state = panelResizeState;
    if (!state || event.pointerId !== state.pointerId) return;

    const { rect, direction } = state;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    let { left, top, width, height } = rect;

    if (direction.includes('e')) {
      width = Math.min(Math.max(rect.width + dx, PANEL_MIN_WIDTH), window.innerWidth - PANEL_EDGE_MARGIN - rect.left);
    }
    if (direction.includes('w')) {
      width = Math.min(Math.max(rect.width - dx, PANEL_MIN_WIDTH), rect.right - PANEL_EDGE_MARGIN);
      left = rect.right - width;
    }
    if (!settings.collapsed && direction.includes('s')) {
      height = Math.min(Math.max(rect.height + dy, PANEL_MIN_HEIGHT), window.innerHeight - PANEL_EDGE_MARGIN - rect.top);
    }
    if (!settings.collapsed && direction.includes('n')) {
      height = Math.min(Math.max(rect.height - dy, PANEL_MIN_HEIGHT), rect.bottom - PANEL_EDGE_MARGIN);
      top = rect.bottom - height;
    }

    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.width = `${width}px`;
    if (!settings.collapsed && /[ns]/.test(direction)) {
      root.style.height = `${height}px`;
    }
    event.preventDefault();
  }

  function stopPanelResize(event, handle) {
    const state = panelResizeState;
    if (!state || event.pointerId !== state.pointerId) return;

    handle.releasePointerCapture?.(event.pointerId);
    panelResizeState = null;
    delete root.dataset.resizing;

    const rect = root.getBoundingClientRect();
    settings.panelWidth = Math.round(rect.width);
    if (!settings.collapsed && /[ns]/.test(state.direction)) {
      settings.panelHeight = Math.round(rect.height);
    }
    saveSettings();
    savePanelPosition();
    event.preventDefault();
  }

  function setCollapsed(collapsed) {
    settings.collapsed = Boolean(collapsed);
    root.classList.toggle('kokoro-collapsed', settings.collapsed);
    if (collapseButtonEl) {
      collapseButtonEl.textContent = settings.collapsed ? 'Open' : 'Hide';
      collapseButtonEl.title = settings.collapsed ? 'Expand the panel' : 'Collapse the panel';
      collapseButtonEl.setAttribute('aria-expanded', String(!settings.collapsed));
    }
    saveSettings();
    applyPanelSize();
    if (!settings.collapsed && !isBusy) refreshLatestPreview();
    requestAnimationFrame(keepPanelInViewport);
  }

  function refreshLatestPreview() {
    if (!latestPreviewEl || latestPreviewEl.dataset.auto === 'false') return;
    findLatestText();
  }

  function scheduleLatestPreviewRefresh(mutations) {
    if (settings.collapsed || isBusy || !root) return;
    if (mutations.every((mutation) => root.contains(mutation.target))) return;

    clearTimeout(previewRefreshTimer);
    previewRefreshTimer = setTimeout(refreshLatestPreview, 1200);
  }

  async function readLatestMessage() {
    if (!await prepareAudioFromClick()) return;
    saveFromControls();
    if (!settings.useByok) await loadVoices();
    await speakText(findLatestText(), 'latest message');
  }

  function buildUi() {
    if (document.getElementById(ROOT_ID)) return;

    GM_addStyle(`
      #${ROOT_ID} {
        --kvs-bg: #0f172a;
        --kvs-surface: rgba(255, 255, 255, 0.04);
        --kvs-surface-strong: #1e293b;
        --kvs-surface-hover: #334155;
        --kvs-border: rgba(148, 163, 184, 0.22);
        --kvs-text: #f1f5f9;
        --kvs-muted: #94a3b8;
        --kvs-accent: #6366f1;
        --kvs-accent-hover: #818cf8;
        --kvs-danger: #b91c1c;
        --kvs-danger-hover: #dc2626;
        --kvs-progress: 0;
        position: fixed;
        z-index: 2147483647;
        right: 14px;
        bottom: 14px;
        display: flex;
        flex-direction: column;
        width: min(${PANEL_DEFAULT_WIDTH}px, calc(100vw - ${PANEL_EDGE_MARGIN * 2}px));
        max-width: calc(100vw - ${PANEL_EDGE_MARGIN * 2}px);
        max-height: calc(100vh - ${PANEL_EDGE_MARGIN * 2}px);
        min-width: min(${PANEL_MIN_WIDTH}px, calc(100vw - ${PANEL_EDGE_MARGIN * 2}px));
        container-name: kvs;
        container-type: inline-size;
        color: var(--kvs-text);
        background: var(--kvs-bg);
        border: 1px solid var(--kvs-border);
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.2);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.4;
        text-align: left;
      }

      #${ROOT_ID} * {
        box-sizing: border-box;
      }

      #${ROOT_ID}[data-dragging="true"],
      #${ROOT_ID}[data-resizing="true"] {
        user-select: none;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 2px var(--kvs-accent);
      }

      #${ROOT_ID} .kokoro-header {
        position: relative;
        display: flex;
        flex: none;
        align-items: center;
        gap: 8px;
        padding: 8px 8px 8px 12px;
        border-bottom: 1px solid var(--kvs-border);
        border-radius: 12px 12px 0 0;
        background: linear-gradient(180deg, rgba(99, 102, 241, 0.16), rgba(99, 102, 241, 0.02));
        cursor: move;
        touch-action: none;
        user-select: none;
      }

      #${ROOT_ID}.kokoro-collapsed .kokoro-header {
        border-bottom: 0;
        border-radius: 12px;
      }

      #${ROOT_ID} .kokoro-header::after {
        content: "";
        position: absolute;
        left: 0;
        bottom: -1px;
        height: 2px;
        width: calc(var(--kvs-progress) * 100%);
        background: var(--kvs-accent);
        border-radius: 0 2px 2px 0;
        pointer-events: none;
      }

      #${ROOT_ID} .kokoro-title-group {
        display: grid;
        flex: 1 1 auto;
        min-width: 0;
      }

      #${ROOT_ID} .kokoro-title {
        overflow: hidden;
        font-weight: 700;
        letter-spacing: 0;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      #${ROOT_ID} .kokoro-title::before {
        content: "";
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 8px;
        border-radius: 50%;
        background: var(--kvs-muted);
        vertical-align: 1px;
      }

      #${ROOT_ID}[data-active] .kokoro-title::before {
        background: #22c55e;
        box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25);
      }

      #${ROOT_ID} .kokoro-mini-status {
        display: none;
        overflow: hidden;
        color: var(--kvs-muted);
        font-size: 11px;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      #${ROOT_ID} .kokoro-mini-status[data-tone="ok"] { color: #86efac; }
      #${ROOT_ID} .kokoro-mini-status[data-tone="warn"] { color: #fcd34d; }
      #${ROOT_ID} .kokoro-mini-status[data-tone="error"] { color: #fca5a5; }

      #${ROOT_ID}.kokoro-collapsed .kokoro-mini-status {
        display: block;
      }

      #${ROOT_ID} .kokoro-header-actions {
        display: flex;
        flex: none;
        gap: 6px;
      }

      #${ROOT_ID} .kokoro-header-actions button {
        width: auto;
        min-width: 64px;
        min-height: 32px;
        padding: 5px 12px;
      }

      #${ROOT_ID} .kokoro-header-actions button[data-action="mini-read"] {
        display: none;
        min-width: 78px;
      }

      #${ROOT_ID}.kokoro-collapsed .kokoro-header-actions button[data-action="mini-read"] {
        display: inline-block;
      }

      #${ROOT_ID} button[data-action="mini-read"][data-state="stop"] {
        border-color: transparent;
        background: var(--kvs-danger);
      }

      #${ROOT_ID} button[data-action="mini-read"][data-state="stop"]:hover:not(:disabled) {
        background: var(--kvs-danger-hover);
      }

      #${ROOT_ID} .kokoro-body {
        display: grid;
        flex: 1 1 auto;
        min-height: 0;
        grid-template-columns: minmax(0, 1fr);
        align-content: start;
        gap: 10px;
        padding: 12px;
        overflow: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
      }

      #${ROOT_ID}.kokoro-collapsed .kokoro-body {
        display: none;
      }

      #${ROOT_ID} .kokoro-col {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
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
        border: 1px solid var(--kvs-border);
        border-radius: 8px;
        background: var(--kvs-surface);
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
        color: var(--kvs-muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
      }

      #${ROOT_ID} button,
      #${ROOT_ID} input,
      #${ROOT_ID} select,
      #${ROOT_ID} textarea {
        width: 100%;
        margin: 0;
        border: 1px solid var(--kvs-border);
        border-radius: 8px;
        color: var(--kvs-text);
        background: var(--kvs-surface-strong);
        font: inherit;
      }

      #${ROOT_ID} button {
        min-height: 34px;
        padding: 7px 9px;
        font-weight: 650;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease;
      }

      #${ROOT_ID} button:hover:not(:disabled) {
        background: var(--kvs-surface-hover);
      }

      #${ROOT_ID} button:focus-visible,
      #${ROOT_ID} input:focus-visible,
      #${ROOT_ID} select:focus-visible,
      #${ROOT_ID} textarea:focus-visible,
      #${ROOT_ID} summary:focus-visible {
        outline: 2px solid var(--kvs-accent-hover);
        outline-offset: 1px;
      }

      #${ROOT_ID} button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      #${ROOT_ID} button[data-action="read-latest"],
      #${ROOT_ID} button[data-action="mini-read"] {
        border-color: transparent;
        background: var(--kvs-accent);
      }

      #${ROOT_ID} button[data-action="read-latest"]:hover:not(:disabled),
      #${ROOT_ID} button[data-action="mini-read"]:hover:not(:disabled) {
        background: var(--kvs-accent-hover);
      }

      #${ROOT_ID} button[data-action="stop"] {
        border-color: transparent;
        background: var(--kvs-danger);
      }

      #${ROOT_ID} button[data-action="stop"]:hover:not(:disabled) {
        background: var(--kvs-danger-hover);
      }

      #${ROOT_ID} input,
      #${ROOT_ID} select {
        min-height: 34px;
        padding: 6px 8px;
      }

      #${ROOT_ID} input[type="range"] {
        min-height: 24px;
        padding: 0;
        border: 0;
        background: transparent;
        accent-color: var(--kvs-accent);
      }

      #${ROOT_ID} textarea {
        flex: 1 1 auto;
        min-height: 110px;
        resize: vertical;
        padding: 8px;
        white-space: pre-wrap;
      }

      #${ROOT_ID} .kokoro-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      #${ROOT_ID} .kokoro-text-field {
        flex: 1 1 auto;
      }

      #${ROOT_ID} .kokoro-field[hidden] {
        display: none;
      }

      #${ROOT_ID} .kokoro-field > span {
        color: var(--kvs-muted);
        font-size: 12px;
        font-weight: 600;
      }

      #${ROOT_ID} .kokoro-toggle-field {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        color: var(--kvs-muted);
        font-size: 12px;
        cursor: pointer;
      }

      #${ROOT_ID} .kokoro-toggle-field[hidden] {
        display: none;
      }

      #${ROOT_ID} .kokoro-toggle-field input {
        width: auto;
        min-height: auto;
        margin: 0;
        accent-color: var(--kvs-accent);
      }

      #${ROOT_ID} .kokoro-byok-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
      }

      #${ROOT_ID} .kokoro-byok-row > .kokoro-toggle-field {
        flex: none;
      }

      #${ROOT_ID} .kokoro-provider-toggle {
        display: grid;
        flex: 1 1 180px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 2px;
        border: 1px solid var(--kvs-border);
        border-radius: 8px;
        background: var(--kvs-surface);
      }

      #${ROOT_ID} .kokoro-provider-toggle[hidden] {
        display: none;
      }

      #${ROOT_ID} .kokoro-provider-toggle button {
        min-height: 28px;
        padding: 5px 7px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        font-size: 12px;
      }

      #${ROOT_ID} .kokoro-provider-toggle button[data-active="true"] {
        background: var(--kvs-accent);
      }

      #${ROOT_ID} .kokoro-advanced {
        border: 1px solid var(--kvs-border);
        border-radius: 8px;
        background: var(--kvs-surface);
      }

      #${ROOT_ID} .kokoro-advanced > summary {
        padding: 8px 10px;
        color: var(--kvs-text);
        font-weight: 650;
        cursor: pointer;
        user-select: none;
      }

      #${ROOT_ID} .kokoro-advanced-body {
        display: grid;
        gap: 8px;
        padding: 0 10px 10px;
      }

      #${ROOT_ID} .kokoro-hint {
        color: var(--kvs-muted);
        font-size: 11px;
      }

      #${ROOT_ID} .kokoro-status,
      #${ROOT_ID} .kokoro-preview {
        min-height: 32px;
        padding: 8px 10px;
        border: 1px solid var(--kvs-border);
        border-left-width: 3px;
        border-radius: 8px;
        background: var(--kvs-surface);
        color: #dbeafe;
        overflow-wrap: anywhere;
      }

      #${ROOT_ID} .kokoro-preview {
        max-height: 140px;
        overflow: auto;
        color: #cbd5e1;
        font-size: 12px;
      }

      #${ROOT_ID} .kokoro-status[data-tone="ok"] {
        border-left-color: #22c55e;
        color: #bbf7d0;
      }

      #${ROOT_ID} .kokoro-status[data-tone="warn"] {
        border-left-color: #f59e0b;
        color: #fde68a;
      }

      #${ROOT_ID} .kokoro-status[data-tone="error"] {
        border-left-color: #ef4444;
        color: #fecaca;
      }

      #${ROOT_ID} .kokoro-resize {
        position: absolute;
        z-index: 2;
        touch-action: none;
      }

      #${ROOT_ID} .kokoro-resize[data-resize="n"],
      #${ROOT_ID} .kokoro-resize[data-resize="s"] {
        left: 12px;
        right: 12px;
        height: 8px;
        cursor: ns-resize;
      }

      #${ROOT_ID} .kokoro-resize[data-resize="e"],
      #${ROOT_ID} .kokoro-resize[data-resize="w"] {
        top: 12px;
        bottom: 12px;
        width: 8px;
        cursor: ew-resize;
      }

      #${ROOT_ID} .kokoro-resize[data-resize="n"] { top: -4px; }
      #${ROOT_ID} .kokoro-resize[data-resize="s"] { bottom: -4px; }
      #${ROOT_ID} .kokoro-resize[data-resize="e"] { right: -4px; }
      #${ROOT_ID} .kokoro-resize[data-resize="w"] { left: -4px; }

      #${ROOT_ID} .kokoro-resize[data-resize="ne"],
      #${ROOT_ID} .kokoro-resize[data-resize="nw"],
      #${ROOT_ID} .kokoro-resize[data-resize="se"],
      #${ROOT_ID} .kokoro-resize[data-resize="sw"] {
        width: 16px;
        height: 16px;
      }

      #${ROOT_ID} .kokoro-resize[data-resize="ne"] { top: -4px; right: -4px; cursor: nesw-resize; }
      #${ROOT_ID} .kokoro-resize[data-resize="sw"] { bottom: -4px; left: -4px; cursor: nesw-resize; }
      #${ROOT_ID} .kokoro-resize[data-resize="nw"] { top: -4px; left: -4px; cursor: nwse-resize; }
      #${ROOT_ID} .kokoro-resize[data-resize="se"] { bottom: -4px; right: -4px; cursor: nwse-resize; }

      #${ROOT_ID} .kokoro-resize[data-resize="se"]::after {
        content: "";
        position: absolute;
        right: 7px;
        bottom: 7px;
        width: 8px;
        height: 8px;
        border-right: 2px solid var(--kvs-muted);
        border-bottom: 2px solid var(--kvs-muted);
        border-radius: 0 0 3px 0;
        opacity: 0.6;
      }

      #${ROOT_ID}.kokoro-collapsed .kokoro-resize:not([data-resize="e"]):not([data-resize="w"]) {
        display: none;
      }

      @container kvs (min-width: 640px) {
        #${ROOT_ID} .kokoro-body {
          grid-template-columns: minmax(260px, 1fr) minmax(0, 1.2fr);
          align-content: stretch;
        }
      }

      @container kvs (max-width: 330px) {
        #${ROOT_ID} .kokoro-body {
          padding: 10px;
        }

        #${ROOT_ID} .kokoro-controls {
          gap: 4px;
        }

        #${ROOT_ID} .kokoro-controls button {
          padding: 6px 4px;
          font-size: 12px;
        }

        #${ROOT_ID} .kokoro-header-actions button {
          min-width: 0;
          padding: 5px 9px;
        }
      }

      @media (max-width: 520px) {
        #${ROOT_ID} {
          right: ${PANEL_EDGE_MARGIN}px;
          bottom: ${PANEL_EDGE_MARGIN}px;
        }

        #${ROOT_ID} .kokoro-resize {
          display: none;
        }
      }
    `);

    root = document.createElement('section');
    root.id = ROOT_ID;
    root.className = settings.collapsed ? 'kokoro-collapsed' : '';
    root.setAttribute('aria-label', 'JanitorAI Voice Studio');

    const header = document.createElement('div');
    header.className = 'kokoro-header';
    header.title = 'Drag to move. Double-click to reset size and position.';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'kokoro-title-group';

    const title = document.createElement('div');
    title.className = 'kokoro-title';
    title.textContent = 'JanitorAI Voice Studio';

    miniStatusEl = document.createElement('div');
    miniStatusEl.className = 'kokoro-mini-status';
    miniStatusEl.setAttribute('aria-live', 'polite');
    titleGroup.append(title, miniStatusEl);

    const headerActions = document.createElement('div');
    headerActions.className = 'kokoro-header-actions';
    miniReadButtonEl = createButton('▶ Read', 'mini-read');
    collapseButtonEl = createButton(settings.collapsed ? 'Open' : 'Hide', 'collapse');
    headerActions.append(miniReadButtonEl, collapseButtonEl);
    header.append(titleGroup, headerActions);

    const body = document.createElement('div');
    body.className = 'kokoro-body';

    const mainColumn = document.createElement('div');
    mainColumn.className = 'kokoro-col';

    const sideColumn = document.createElement('div');
    sideColumn.className = 'kokoro-col';

    const actionRow = document.createElement('div');
    actionRow.className = 'kokoro-row';
    const readLatestButton = createButton('Read latest', 'read-latest');
    readLatestButton.title = 'Read the latest bot message (Alt+Shift+R)';
    const readSelectedButton = createButton('Read selected', 'read-selected');
    readSelectedButton.title = 'Read the text currently selected on the page';
    actionRow.append(readLatestButton, readSelectedButton);

    const actionRow2 = document.createElement('div');
    actionRow2.className = 'kokoro-row';
    const readBoxButton = createButton('Read box', 'read-box');
    readBoxButton.title = 'Read the contents of the text box';
    const stopButton = createButton('Stop', 'stop');
    stopButton.title = 'Stop generation and playback (Alt+Shift+S)';
    actionRow2.append(readBoxButton, stopButton);

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
    progressInputEl.setAttribute('aria-label', 'Playback position');

    timeEl = document.createElement('div');
    timeEl.className = 'kokoro-time';
    timeEl.textContent = '0:00 / 0:00';

    progressRow.append(progressInputEl, timeEl);
    controller.append(controlButtons, progressRow);

    manualTextEl = document.createElement('textarea');
    manualTextEl.placeholder = 'Paste text here, including **bold**, *italics*, timestamps, narration, and dialogue.';
    manualTextEl.value = settings.manualText || '';

    apiKeyInputEl = document.createElement('input');
    apiKeyInputEl.value = settings.cpuApiKey;
    apiKeyInputEl.type = 'password';
    apiKeyInputEl.autocomplete = 'off';
    apiKeyInputEl.placeholder = 'CPU Space API_PASSWORD';

    hfTokenInputEl = document.createElement('input');
    hfTokenInputEl.value = settings.hfToken;
    hfTokenInputEl.type = 'password';
    hfTokenInputEl.autocomplete = 'off';
    hfTokenInputEl.placeholder = 'hf_... token with read access';

    gpuToggleEl = document.createElement('input');
    gpuToggleEl.type = 'checkbox';
    gpuToggleEl.checked = Boolean(settings.useGpu);

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
    gpuToggleFieldEl = createCheckboxField('ZeroGPU', gpuToggleEl);
    byokRowEl.append(
      createCheckboxField('Use BYOK', byokToggleEl),
      gpuToggleFieldEl,
      providerToggleEl,
    );
    openRouterApiKeyFieldEl = createField('OpenRouter API key', openRouterApiKeyInputEl);
    mimoApiKeyFieldEl = createField('Mimo API key', mimoApiKeyInputEl);
    apiKeyFieldEl = createField('CPU Space API key', apiKeyInputEl);
    hfTokenFieldEl = createField('Hugging Face token', hfTokenInputEl);

    const layoutRow = document.createElement('div');
    layoutRow.className = 'kokoro-row';
    const resetLayoutButton = createButton('Reset panel layout', 'reset-layout');
    resetLayoutButton.title = 'Restore the default panel size and position';
    const hint = document.createElement('div');
    hint.className = 'kokoro-hint';
    hint.textContent = 'Drag edges to resize. Alt+Shift+R reads latest, Alt+Shift+S stops (outside text fields).';
    layoutRow.append(resetLayoutButton, hint);

    advancedBody.append(
      byokRowEl,
      openRouterApiKeyFieldEl,
      mimoApiKeyFieldEl,
      apiKeyFieldEl,
      hfTokenFieldEl,
      layoutRow,
    );

    advanced.append(advancedSummary, advancedBody);

    statusEl = document.createElement('div');
    statusEl.className = 'kokoro-status';
    statusEl.dataset.tone = 'info';
    statusEl.setAttribute('aria-live', 'polite');

    latestPreviewEl = document.createElement('div');
    latestPreviewEl.className = 'kokoro-preview';
    latestPreviewEl.textContent = 'Text preview and character count appear here.';

    const textField = createField('Text box', manualTextEl);
    textField.classList.add('kokoro-text-field');

    mainColumn.append(
      actionRow,
      actionRow2,
      controller,
      statusEl,
      settingsRow,
      advanced,
    );
    sideColumn.append(
      textField,
      latestPreviewEl,
    );
    body.append(mainColumn, sideColumn);

    const resizeHandles = RESIZE_DIRECTIONS.map((direction) => {
      const handle = document.createElement('div');
      handle.className = 'kokoro-resize';
      handle.dataset.resize = direction;
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (event) => {
        startPanelResize(event, handle);
      });
      handle.addEventListener('pointermove', resizePanel);
      handle.addEventListener('pointerup', (event) => {
        stopPanelResize(event, handle);
      });
      handle.addEventListener('pointercancel', (event) => {
        stopPanelResize(event, handle);
      });
      return handle;
    });

    root.append(header, body, ...resizeHandles);
    document.body.append(root);
    setStatus(`Ready. v${USER_SCRIPT_VERSION}`, 'info');
    updatePlaybackControls();
    restorePanelLayout();
    if (collapseButtonEl) {
      collapseButtonEl.setAttribute('aria-expanded', String(!settings.collapsed));
    }

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

    header.addEventListener('dblclick', (event) => {
      if (event.target?.closest?.('button')) return;
      resetPanelLayout();
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
        : `Kokoro ${settings.useGpu ? 'ZeroGPU' : 'CPU'} Space selected.`, 'info');
    });

    gpuToggleEl.addEventListener('change', () => {
      saveFromControls();
      updateByokProviderControls();
      loadProviderVoices();
      setStatus(`Kokoro ${settings.useGpu ? 'ZeroGPU' : 'CPU'} Space selected.`, 'info');
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
        setCollapsed(!settings.collapsed);
        return;
      }

      if (action === 'mini-read') {
        if (isAudioActive()) {
          stopPlayback();
          return;
        }
        await readLatestMessage();
        return;
      }

      if (action === 'reset-layout') {
        resetPanelLayout();
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
        await readLatestMessage();
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

    document.addEventListener('keydown', (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat) return;

      const key = event.code === 'KeyR' ? 'r' : event.code === 'KeyS' ? 's' : '';
      if (!key) return;

      const target = event.target;
      if (
        isElementNode(target)
        && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      ) return;

      event.preventDefault();
      if (key === 's') {
        stopPlayback();
      } else if (!isBusy) {
        readLatestMessage();
      }
    }, true);

    document.addEventListener('selectionchange', updateRememberedSelection);
    document.addEventListener('keyup', updateRememberedSelection, true);
    document.addEventListener('pointerup', updateRememberedSelection, true);

    new MutationObserver(scheduleLatestPreviewRefresh).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    findLatestText();
    loadProviderVoices();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUi, { once: true });
  } else {
    buildUi();
  }
})();
