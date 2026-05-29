document.addEventListener('DOMContentLoaded', async () => {
  const getEl = (id) => document.getElementById(id);

  const apiKeyInput = getEl('api-key');
  const userContextInput = getEl('user-context');
  const startBtn = getEl('start-btn');
  const fetchSelfBtn = getEl('fetch-self-btn');
  const clearBtn = getEl('clear-btn');
  const statusMsg = getEl('status-msg');
  const modelTextSelect = getEl('model-text');
  const helpBtn = getEl('help-btn');

  // 1. 初始化：載入設定
  const storage = await chrome.storage.local.get([
    'GEMINI_API_KEY', 
    'USER_CONTEXT_CACHE', 
    'USER_CONTEXT_URL', 
    'PREFERRED_MODELS'
  ]);
  
  if (apiKeyInput && storage.GEMINI_API_KEY) apiKeyInput.value = storage.GEMINI_API_KEY;
  if (userContextInput && storage.USER_CONTEXT_CACHE) userContextInput.value = storage.USER_CONTEXT_CACHE;
  
  if (storage.PREFERRED_MODELS) {
    if (modelTextSelect && storage.PREFERRED_MODELS.text) {
      modelTextSelect.value = storage.PREFERRED_MODELS.text;
    }
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
        text: modelTextSelect ? modelTextSelect.value : 'gemini-3.5-flash'
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
          'CURRENT_ANALYSIS_DATA'
        ]);

        // 清空 UI
        if (apiKeyInput) apiKeyInput.value = '';
        if (userContextInput) userContextInput.value = '';

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