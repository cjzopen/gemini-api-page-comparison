// ===== Gemini 模型清單設定 =====
// 清單改由 Google 官方 ListModels API 動態取得，Google 上/下架模型時不需再手動改程式碼。
const MODEL_LIST_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// 沒有 API Key 或連線失敗時的後備清單 (只是讓 UI 不空白，實際仍以 API 回傳為準)
const FALLBACK_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (標準/預設)' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro (深度分析)' }
];
const DEFAULT_MODEL_ID = FALLBACK_MODELS[0].id;

// 只保留 Gemini 文字系列 (未來若 Google 推出新家族，在此加前綴即可)
const MODEL_FAMILY_PREFIXES = ['gemini-'];

// 過濾掉與「文字戰略分析」無關的模型：生圖 / 影片 / 語音 / 向量 / 即時對話 / 舊版純視覺
const MODEL_EXCLUDE_PATTERNS = [
  'embedding', 'embed',      // 向量
  'imagen', 'image',         // 生圖 (含 flash-image / image-generation)
  'veo', 'video',            // 影片
  'tts', 'audio', 'speech',  // 語音
  'live', 'realtime',        // 即時串流對話
  'vision',                  // 舊版純圖片分析 (gemini-pro-vision)
  'aqa'                      // 問答歸因專用
];

function normalizeModelId(name) {
  return String(name || '').replace(/^models\//, '');
}

// 判斷是否為可用於戰略分析的文字模型
function isStrategyTextModel(model) {
  const id = normalizeModelId(model.name).toLowerCase();
  if (!id) return false;

  // 必須支援一般文字生成
  const methods = model.supportedGenerationMethods || [];
  if (!methods.includes('generateContent')) return false;

  if (!MODEL_FAMILY_PREFIXES.some(prefix => id.startsWith(prefix))) return false;
  if (MODEL_EXCLUDE_PATTERNS.some(pattern => id.includes(pattern))) return false;

  return true;
}

// 排序：版本新的在前 → 正式版優先於預覽版 → Pro > Flash > Flash-Lite
function modelSortKey(id) {
  const versionMatch = id.match(/gemini-(\d+(?:\.\d+)?)/);
  const version = versionMatch ? parseFloat(versionMatch[1]) : 0;
  const isPreview = /(preview|exp|experimental|latest|\d{3,})/.test(id) ? 1 : 0;
  let tier = 3;
  if (id.includes('pro')) tier = 0;
  else if (id.includes('flash-lite')) tier = 2;
  else if (id.includes('flash')) tier = 1;
  return [-version, isPreview, tier, id.length, id];
}

function compareModels(a, b) {
  const ka = modelSortKey(a.id);
  const kb = modelSortKey(b.id);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function buildModelLabel(model) {
  const id = normalizeModelId(model.name);
  const display = model.displayName || id;
  const isPreview = /(preview|exp|experimental)/i.test(id);
  return isPreview ? `${display} [預覽]` : display;
}

// 向 Google 取得完整模型清單 (自動翻頁)，再過濾成文字分析可用的模型
async function fetchGeminiModels(apiKey) {
  const rawModels = [];
  let pageToken = '';
  let page = 0;

  do {
    const params = new URLSearchParams({ key: apiKey, pageSize: '200' });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${MODEL_LIST_ENDPOINT}?${params.toString()}`);
    if (!res.ok) {
      let detail = '';
      try {
        const errJson = await res.json();
        detail = errJson?.error?.message || '';
      } catch (e) { /* 忽略非 JSON 的錯誤內容 */ }
      throw new Error(`(${res.status}) ${detail || '無法取得模型清單'}`);
    }

    const json = await res.json();
    rawModels.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
    page++;
  } while (pageToken && page < 10);

  return rawModels
    .filter(isStrategyTextModel)
    .map(m => ({ id: normalizeModelId(m.name), label: buildModelLabel(m) }))
    .sort(compareModels);
}

// 沒有偏好設定時，挑一個合理的預設 (最新的正式版 Flash，其次是清單第一個)
function pickDefaultModel(models) {
  const stableFlash = models.find(m => m.id.includes('flash') && !/(preview|exp)/i.test(m.id));
  return (stableFlash || models[0])?.id || DEFAULT_MODEL_ID;
}

document.addEventListener('DOMContentLoaded', async () => {
  const getEl = (id) => document.getElementById(id);

  const apiKeyInput = getEl('api-key');
  const userContextInput = getEl('user-context');
  const startBtn = getEl('start-btn');
  const fetchSelfBtn = getEl('fetch-self-btn');
  const clearBtn = getEl('clear-btn');
  const statusMsg = getEl('status-msg');
  const modelTextSelect = getEl('model-text');
  const modelHint = getEl('model-hint');
  const helpBtn = getEl('help-btn');

  // 1. 初始化：載入設定
  const storage = await chrome.storage.local.get([
    'GEMINI_API_KEY',
    'USER_CONTEXT_CACHE',
    'USER_CONTEXT_URL',
    'PREFERRED_MODELS',
    'MODEL_LIST_CACHE'
  ]);

  if (apiKeyInput && storage.GEMINI_API_KEY) apiKeyInput.value = storage.GEMINI_API_KEY;
  if (userContextInput && storage.USER_CONTEXT_CACHE) userContextInput.value = storage.USER_CONTEXT_CACHE;

  // 2. 模型清單：先用快取 (或後備清單) 讓 UI 立即可用，有 Key 就抓一次最新清單
  const preferredModelId = storage.PREFERRED_MODELS?.text || '';
  const cachedModels = storage.MODEL_LIST_CACHE?.models;

  if (Array.isArray(cachedModels) && cachedModels.length > 0) {
    renderModelOptions(cachedModels, preferredModelId);
    setModelHint(`共 ${cachedModels.length} 個可用模型`);
  } else {
    renderModelOptions(FALLBACK_MODELS, preferredModelId);
    setModelHint('尚未載入官方清單，目前顯示預設模型');
  }

  if (storage.GEMINI_API_KEY) loadModelList(storage.GEMINI_API_KEY);

  // 輸入 (或換掉) API Key 後抓一次；不同 Key 可用的模型可能不同
  if (apiKeyInput) {
    apiKeyInput.addEventListener('change', () => {
      const key = apiKeyInput.value.trim();
      if (key && key !== storage.GEMINI_API_KEY) loadModelList(key);
    });
  }



  // 3. 抓取當前頁面 (我方資料)
  if (fetchSelfBtn) {
    fetchSelfBtn.addEventListener('click', async () => {
      try {
        showMsg("正在深度掃描我方頁面...", "blue");
        
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.startsWith('http')) throw new Error("僅支援一般網頁");

        const injection = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageContent
        });

        if (!injection || !injection[0] || !injection[0].result) throw new Error("無法讀取內容");

        const data = injection[0].result;
        
        let summaryText = `【來源網頁標題】: ${data.title}\n`;
        summaryText += `【URL】: ${data.url}\n`;
        summaryText += `【Meta 描述】: ${data.meta.description}\n`;
        if (data.jsonLd && data.jsonLd.length > 0) {
             summaryText += `【結構化資料】: ${JSON.stringify(data.jsonLd)}\n`;
        }

        summaryText += `【視覺核心內容 (含隱藏重點)】:\n`;
        summaryText += data.visualHighlights.map(h => {
          let prefix = `[${h.tag} | w:${h.weight}]`;
          if (h.tag === 'IMG') prefix = `[圖片 | w:${h.weight}]`;
          if (h.tag === 'IFRAME') prefix = `[嵌入 | w:${h.weight}]`;
          if (h.isHidden) prefix += ` (隱藏)`;
          return `${prefix} ${h.text}`;
        }).join('\n');

        if (userContextInput) {
          userContextInput.value = summaryText;
          // 儲存內容時，一併儲存我方網址
          await chrome.storage.local.set({ 
            'USER_CONTEXT_CACHE': summaryText,
            'USER_CONTEXT_URL': data.url
          });
        }

        showMsg("✅ 已抓取並儲存！請前往競品頁面。", "green");
      } catch (err) {
        showMsg("抓取失敗: " + err.message);
      }
    });
  }

  // 4. 開始分析 (競品)
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
      const userContext = userContextInput ? userContextInput.value.trim() : '';
      
      const selectedModels = {
        text: (modelTextSelect && modelTextSelect.value) || DEFAULT_MODEL_ID
      };

      if (!apiKey) {
        showMsg("請輸入 API Key");
        return;
      }

      chrome.storage.local.set({ 
        'GEMINI_API_KEY': apiKey,
        'USER_CONTEXT_CACHE': userContext,
        'PREFERRED_MODELS': selectedModels
      });

      // [防呆檢查]
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.startsWith('http')) throw new Error("僅支援一般網頁");

        const currentStorage = await chrome.storage.local.get(['USER_CONTEXT_URL']);
        
        if (currentStorage.USER_CONTEXT_URL && isSamePage(currentStorage.USER_CONTEXT_URL, tab.url)) {
          showMsg("⛔ 錯誤：競品頁面與我方頁面相同！\n請切換到競爭對手的網站後再點擊分析。", "red");
          return;
        }

        showMsg("正在分析競品頁面...", "blue");
        startBtn.disabled = true;

        const injection = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageContent
        });

        if (!injection || !injection[0] || !injection[0].result) throw new Error("無法讀取內容");

        const pageData = injection[0].result;

        await chrome.storage.local.set({
          'CURRENT_ANALYSIS_DATA': {
            competitorData: pageData,
            userData: userContext,
            timestamp: Date.now(),
            models: selectedModels
          }
        });

        chrome.tabs.create({ url: 'report.html' });
        window.close();

      } catch (err) {
        showMsg(err.message);
        startBtn.disabled = false;
      }
    });
  }

  // 5. 清除快取功能
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      // 簡單確認
      if (!confirm("確定要刪除所有資料嗎？\n這將移除 API Key、我方產品資料與模型設定。")) {
        return;
      }

      try {
        // 清除 Storage 中本專案相關的所有 key
        await chrome.storage.local.remove([
          'GEMINI_API_KEY',
          'USER_CONTEXT_CACHE',
          'USER_CONTEXT_URL',
          'PREFERRED_MODELS',
          'MODEL_LIST_CACHE',
          'CURRENT_ANALYSIS_DATA'
        ]);

        // 清空 UI
        if (apiKeyInput) apiKeyInput.value = '';
        if (userContextInput) userContextInput.value = '';
        renderModelOptions(FALLBACK_MODELS, '');
        setModelHint('尚未載入官方清單，目前顯示預設模型');

        showMsg("🗑️ 所有機敏資料與快取已清除！", "green");
      } catch (err) {
        showMsg("清除失敗: " + err.message, "red");
      }
    });
  }

  // 6. 說明頁面導覽
  if (helpBtn) {
    helpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'instructions.html' });
    });
  }

  // --- 輔助函式 ---

  // 把模型清單畫進下拉選單，並盡量保留使用者原本的選擇
  function renderModelOptions(models, preferredId) {
    if (!modelTextSelect) return;

    modelTextSelect.innerHTML = '';
    models.forEach(model => {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label || model.id;
      opt.title = model.id;
      modelTextSelect.appendChild(opt);
    });

    const exists = models.some(m => m.id === preferredId);
    modelTextSelect.value = exists ? preferredId : pickDefaultModel(models);
  }

  function setModelHint(text, isError = false) {
    if (!modelHint) return;
    modelHint.textContent = text;
    modelHint.classList.toggle('error', isError);
  }

  // 向 Google 取得最新模型清單，同時更新 UI 與快取
  async function loadModelList(apiKey) {
    setModelHint('正在取得 Google 最新模型清單…');

    try {
      const models = await fetchGeminiModels(apiKey);
      if (models.length === 0) throw new Error('此 API Key 沒有可用的文字模型');

      const keep = modelTextSelect ? modelTextSelect.value : '';
      renderModelOptions(models, keep);
      await chrome.storage.local.set({ 'MODEL_LIST_CACHE': { models, fetchedAt: Date.now() } });
      setModelHint(`共 ${models.length} 個可用模型`);
    } catch (err) {
      setModelHint(`模型清單更新失敗：${err.message}`, true);
    }
  }

  function isSamePage(urlA, urlB) {
    if (!urlA || !urlB) return false;
    try {
      const a = new URL(urlA);
      const b = new URL(urlB);
      const hostA = a.hostname.replace(/^www\./, '').toLowerCase();
      const hostB = b.hostname.replace(/^www\./, '').toLowerCase();
      if (hostA !== hostB) return false;
      const pathA = a.pathname.replace(/\/$/, '');
      const pathB = b.pathname.replace(/\/$/, '');
      if (pathA !== pathB) return false;
      return true;
    } catch (e) {
      return urlA === urlB;
    }
  }

  function showMsg(text, color = 'red') {
    if (!statusMsg) return;
    statusMsg.style.display = 'block';
    if (color === 'blue') statusMsg.style.color = '#2563eb';
    else if (color === 'green') statusMsg.style.color = '#10b981';
    else statusMsg.style.color = '#ef4444';
    statusMsg.textContent = text;
  }

  // --- 視覺權重抓取邏輯 ---
  function extractPageContent() {
    const excludeSelectors = [
      'nav', 'header', 'footer', 'script', 'style', 'noscript', 
      '.menu', '.nav', '.footer', '.header', '.sidebar', '.top-bar',
      '#menu', '#nav', '#header', '#footer', '#sidebar',
      '.cookie-consent', '.ad', '[data-nosnippet]', '[aria-hidden="true"]'
    ].join(',');

    function isValidOpacity(style) {
      const op = parseFloat(style.opacity);
      if (op === 0) return true;
      if (op > 0 && op < 0.8) return false;
      return true;
    }

    function calculateVisualWeight(element, style, rect) {
      let score = 0;
      const op = parseFloat(style.opacity);
      const isDisplayNone = style.display === 'none';

      if (element.tagName === 'IMG' || element.tagName === 'IFRAME') {
        let w = rect.width;
        let h = rect.height;
        if (isDisplayNone) {
           w = parseFloat(element.getAttribute('width')) || 0;
           h = parseFloat(element.getAttribute('height')) || 0;
        }
        const areaScore = (w * h) / 1000;
        score = Math.min(areaScore, 100); 
        if (isDisplayNone && score === 0) score = 5;
      } else {
        score = parseFloat(style.fontSize) || 16;
        const fontWeight = parseInt(style.fontWeight) || 400;
        if (fontWeight >= 700) score *= 2;
      }

      const viewHeight = window.innerHeight;
      if (!isDisplayNone && rect.top >= 0 && rect.top < viewHeight) score *= 1.5;

      const zIndex = parseInt(style.zIndex);
      const isHidden = op === 0 || isDisplayNone;
      if (isHidden && !isNaN(zIndex) && zIndex > 10) {
        score *= 1.5;
      } else if (!isNaN(zIndex) && zIndex > 100) {
        score *= 1.2;
      }
      
      if (isDisplayNone) score *= 1.1; 

      const role = element.getAttribute('role');
      if (element.tagName === 'BUTTON' || element.tagName === 'A' || role === 'button' || role === 'link') {
        score *= 1.3;
      }
      if (element.hasAttribute('itemprop') || role === 'heading') {
        score *= 1.2;
      }

      return score;
    }

    const allElements = document.querySelectorAll('*');
    const heavyElements = [];

    allElements.forEach(el => {
      if (el.closest(excludeSelectors)) return;
      
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const isDisplayNone = style.display === 'none';

      if (!isDisplayNone && !isValidOpacity(style)) return;
      if (!isDisplayNone && (rect.width < 5 || rect.height < 5)) return;

      const weight = calculateVisualWeight(el, style, rect);
      if (weight < 10) return;

      let textContent = '';
      let tagName = el.tagName;
      const isHidden = parseFloat(style.opacity) === 0 || isDisplayNone;

      if (tagName === 'IMG') {
        const alt = el.getAttribute('alt');
        const title = el.getAttribute('title');
        if (alt && alt.length > 2) textContent = `(圖片: ${alt})`;
        else if (title && title.length > 2) textContent = `(圖片: ${title})`;
        else return;
      } 
      else if (tagName === 'IFRAME') {
        const title = el.getAttribute('title');
        const src = el.getAttribute('src') || '';
        let inferredInfo = '';
        if (src.includes('youtube') || src.includes('vimeo')) inferredInfo = '影片';
        else if (src.includes('map')) inferredInfo = '地圖';
        else if (src.includes('form')) inferredInfo = '表單';
        
        if (title) textContent = `(嵌入: ${title})`;
        else if (inferredInfo) textContent = `(嵌入: ${inferredInfo})`;
        else return;
      }
      else {
        const directText = Array.from(el.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent.trim())
          .join(' ');
          
        if (directText.length > 2) {
          textContent = directText;
        } else {
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel && ariaLabel.length > 2) textContent = `(ARIA: ${ariaLabel})`;
          else return;
        }
      }

      if (textContent) {
        heavyElements.push({
          tag: tagName,
          text: textContent.substring(0, 300),
          weight: Math.round(weight),
          isHidden: isHidden
        });
      }
    });

    heavyElements.sort((a, b) => b.weight - a.weight);
    
    const uniqueElements = [];
    const seenText = new Set();
    for (const el of heavyElements) {
      if (!seenText.has(el.text)) {
        seenText.add(el.text);
        uniqueElements.push(el);
      }
      if (uniqueElements.length >= 80) break;
    }

    return {
      url: window.location.href,
      title: document.title,
      meta: {
        description: document.querySelector('meta[name="description"]')?.content || ''
      },
      jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(el => { try { return JSON.parse(el.innerText) } catch { return null } }).filter(Boolean),
      visualHighlights: uniqueElements
    };
  }
});