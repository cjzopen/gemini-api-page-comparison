document.addEventListener('DOMContentLoaded', async () => {
  const loading = document.getElementById('loading');
  const dashboard = document.getElementById('dashboard');

  try {
    const data = await chrome.storage.local.get(['GEMINI_API_KEY', 'CURRENT_ANALYSIS_DATA']);
    const apiKey = data.GEMINI_API_KEY;
    const analysisData = data.CURRENT_ANALYSIS_DATA;

    if (!apiKey || !analysisData) throw new Error("資料遺失，請重新啟動。");

    // 讀取用戶選擇的模型，若無則使用預設值
    const textModel = analysisData.models?.text || 'gemini-2.5-flash';
    // [修改] 圖片模型預設值改為 gemini-2.5-flash-image
    const imageModel = analysisData.models?.image || 'gemini-2.5-flash-image';

    document.getElementById('target-url').textContent = new URL(analysisData.competitorData.url).hostname;
    document.getElementById('gen-time').textContent = new Date(analysisData.timestamp).toLocaleString();

    // 1. 呼叫 Gemini 執行雙向分析 (傳入模型 ID)
    const aiResult = await callGeminiForDualAnalysis(apiKey, analysisData, textModel);

    // 2. 渲染儀表板
    renderDashboard(aiResult);

    loading.style.display = 'none';
    dashboard.style.display = 'block';

    // 3. 綁定圖片生成按鈕 (傳入模型 ID)
    const btnGenImage = document.getElementById('btn-gen-image');
    btnGenImage.addEventListener('click', () => {
      generateOneSheet(apiKey, aiResult.visualPrompt, btnGenImage, imageModel);
    });

  } catch (err) {
    loading.innerHTML = `<div style="color:red; font-weight:bold;">分析失敗</div><p>${err.message}</p>`;
    console.error(err);
  }
});

// --- API: 雙向戰略分析 (文字生成) ---
async function callGeminiForDualAnalysis(key, data, modelId) {
  // [動態模型] 使用使用者選擇的模型 ID
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;

  const competitorData = data.competitorData;
  const userContext = data.userData || "無詳細我方資料，請基於通用市場標準評估。";

  // 資料壓縮
  const compactHighlights = competitorData.visualHighlights.map(h => 
    [h.tag, h.weight, h.text]
  );

  const systemPrompt = `你是一位戰略顧問。請比較「我方資料」與「競品網頁」，產出深度報告。
【輸入資料】
1.競品內容(格式:[標籤,權重,內容]):${JSON.stringify(compactHighlights).substring(0, 25000)}
2.競品Meta/Schema:${JSON.stringify(competitorData.meta)}/${JSON.stringify(competitorData.jsonLd)}
3.我方資料:"${userContext}"
【評分邏輯強制規則(Critical)】
1."threatScore"(威脅指數)須綜合考量「勝負數量」與「分數差距(Gap)」。
2.情境A(全面輾壓):若競品在3個以上維度勝出且分數大幅領先我方(>20分)，threatScore須>85(極高威脅)。
3.情境B(膠著戰/惜敗):若競品在4-5個維度中勝出但差距小(<10分)，threatScore應落於65-80(高強度競爭)。
4.情境C(我方險勝):若我方在多數維度勝出但差距小(<10分)，threatScore不得低於45。
5.情境D(我方完勝):僅當我方在4個以上維度勝出且大幅領先時，threatScore才可低於30。
6.禁止矛盾:分數與威脅指數須邏輯一致。
【輸出JSON格式(嚴格遵守)】
{
"threatScore":0-100(整數),
"scoreReason":"簡短解釋",
"summary":"100字總結",
"radarData":[
{"dimension":"SEO技術","myScore":0-100,"compScore":0-100,"reason":"解釋落差原因，引用具體發現(如Schema有無)"},
{"dimension":"視覺吸睛","myScore":0-100,"compScore":0-100,"reason":"..."},
{"dimension":"內容深度","myScore":0-100,"compScore":0-100,"reason":"..."},
{"dimension":"信任訊號","myScore":0-100,"compScore":0-100,"reason":"..."},
{"dimension":"轉換強度","myScore":0-100,"compScore":0-100,"reason":"..."}
],
"comparison":[
{"dimension":"維度","mySide":"我方狀況","competitorSide":"競品狀況"}
],
"weaknesses":[{"title":"對手弱點(我方機會)","analysis":"競品哪裡做得不好","advice":"我方如何攻擊"}],
"strengths":[{"title":"對手強項(我方威脅)","analysis":"競品哪裡做得好","advice":"我方如何防禦"}],
"overallAdvice":"...",
"visualPrompt":"一段英文 Prompt，用於生成一張『商務簡報總結 (Business Infographic Summary)』。這是一張『一頁式戰略總結 (One-Page Strategy Strategy)』。核心內容：1. 視覺化展示『攻擊機會 (Attack Opportunities)』與『防禦重點 (Defense Focus)』。2. 包含簡單的圖表(Charts)呈現強弱對比。3. 設計風格：極簡商務 (Minimalist Business), 乾淨 (Clean), 16:9 版面。"
}`;

  const payload = {
    contents: [{ parts: [{ text: systemPrompt }] }],
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ],
    generationConfig: { responseMimeType: "application/json" }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || "API Error");
  
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// --- API: 圖片生成 (Imagen vs Gemini Image 多模型適配) ---
async function generateOneSheet(key, prompt, btn, modelId) {
  const isImagen = modelId.includes('imagen');
  // 檢查是否為 2.5 模型 (Flash Image)
  const isFlash25 = modelId.includes('2.5');
  
  const action = isImagen ? 'predict' : 'generateContent';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:${action}?key=${key}`;
  
  const container = document.getElementById('visual-summary-container');
  
  btn.disabled = true;
  btn.textContent = `🎨 正在繪製簡報 (${modelId})...`;
  container.innerHTML = '<div class="spinner" style="border:4px solid #ddd; border-top-color:#8b5cf6; width:30px; height:30px; border-radius:50%; animation:spin 1s linear infinite;"></div>';

  try {
    let payload = {};

    // 基礎 Prompt: 強制商務簡報風格
    let enhancedPrompt = prompt + " Minimalist Business Infographic Style. One-page presentation summary slide. Visualizing 'Attack Opportunities' vs 'Defense Focus'. Clean layout, professional corporate design, vector graphics. Aspect Ratio 16:9.";

    // 語言控制：2.5 模型用英文，其他(3.0/Imagen)用繁中
    if (isFlash25) {
      enhancedPrompt += " Text labels must be in English.";
    } else {
      enhancedPrompt += " Text labels must be in Traditional Chinese (繁體中文).";
    }

    if (isImagen) {
      // --- Imagen 4.0 格式 ---
      payload = {
        instances: [{ prompt: enhancedPrompt }],
        parameters: { 
          sampleCount: 1,
          aspectRatio: "16:9",
          personGeneration: "dont_allow"
        }
      };
    } else {
      // --- Gemini Image 格式 (3.0 Pro Image / 2.5 Flash Image) ---
      payload = {
        contents: [{
          parts: [{ text: enhancedPrompt }]
        }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio: "16:9"
          },
        }
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || "Image Gen Error");

    let base64 = null;

    if (isImagen) {
      base64 = json.predictions?.[0]?.bytesBase64Encoded;
    } else {
      // Gemini Image 回傳解析
      // 確保抓取到 inlineData，不管它在第幾個 part
      const imagePart = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      base64 = imagePart?.inlineData?.data;
    }
    
    if (!base64) throw new Error("無圖片回傳 (Inline Data missing)");

    container.innerHTML = `<img src="data:image/jpeg;base64,${base64}" alt="Strategy Infographic" style="animation: fadeIn 1s;">`;
    btn.textContent = "✨ 重新生成簡報圖";
    btn.disabled = false;

  } catch (err) {
    container.innerHTML = `<div style="color:red">圖片生成失敗：${err.message}</div>`;
    btn.disabled = false;
    btn.textContent = "重試";
    console.error(err);
  }
}

// --- 渲染邏輯 (維持原樣) ---
function renderDashboard(data) {
  const scoreEl = document.getElementById('threat-score');
  scoreEl.textContent = data.threatScore;
  scoreEl.style.color = data.threatScore > 75 ? '#ef4444' : '#10b981';
  document.getElementById('score-text').textContent = data.scoreReason;
  document.getElementById('summary-content').textContent = data.summary;

  document.getElementById('radar-chart').innerHTML = generateDualRadarSVG(data.radarData);

  const dimContainer = document.getElementById('dimension-analysis');
  dimContainer.innerHTML = data.radarData.map(d => `
    <div class="dim-item">
      <div class="dim-name">${d.dimension}</div>
      <div class="dim-content">
        <div class="bars">
          <div class="bar-wrap" style="color:var(--primary)">
            我方 ${d.myScore}
            <div class="progress"><span class="fill" style="width:${d.myScore}%; background:var(--primary);"></span></div>
          </div>
          <div class="bar-wrap" style="color:var(--competitor)">
            競品 ${d.compScore}
            <div class="progress"><span class="fill" style="width:${d.compScore}%; background:var(--competitor);"></span></div>
          </div>
        </div>
        <div class="reason">${d.reason}</div>
      </div>
    </div>
  `).join('');

  const compTable = document.getElementById('comparison-table-body');
  compTable.innerHTML = (data.comparison || []).map(row => `
    <tr>
      <td>${row.dimension}</td>
      <td style="color:#1e40af; background:#eff6ff;">${row.mySide}</td>
      <td style="color:#991b1b; background:#fef2f2;">${row.competitorSide}</td>
    </tr>
  `).join('');

  document.getElementById('weakness-list').innerHTML = (data.weaknesses || []).map(item => `
    <div class="analysis-item">
      <h4>🎯 ${item.title}</h4>
      <p>${item.analysis}</p>
      <div class="advice-box">${item.advice}</div>
    </div>
  `).join('');

  document.getElementById('strength-list').innerHTML = (data.strengths || []).map(item => `
    <div class="analysis-item">
      <h4>🔥 ${item.title}</h4>
      <p>${item.analysis}</p>
      <div class="advice-box">${item.advice}</div>
    </div>
  `).join('');

  document.getElementById('overall-advice').textContent = data.overallAdvice;
}

function generateDualRadarSVG(radarData) {
  const size = 300;
  const center = size / 2;
  const radius = 100;
  const total = radarData.length;

  const getCoords = (val, i) => {
    const angle = (Math.PI * 2 * i) / total - Math.PI / 2;
    const r = (val / 100) * radius;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
  };

  let gridHTML = '';
  [0.2, 0.4, 0.6, 0.8, 1].forEach(scale => {
    const points = radarData.map((_, i) => {
      const angle = (Math.PI * 2 * i) / total - Math.PI / 2;
      const r = radius * scale;
      return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
    }).join(' ');
    gridHTML += `<polygon points="${points}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`;
  });

  const myPoints = radarData.map((d, i) => getCoords(d.myScore, i).join(',')).join(' ');
  const compPoints = radarData.map((d, i) => getCoords(d.compScore, i).join(',')).join(' ');

  const labelsHTML = radarData.map((d, i) => {
    const angle = (Math.PI * 2 * i) / total - Math.PI / 2;
    const r = radius + 25;
    const x = center + r * Math.cos(angle);
    const y = center + r * Math.sin(angle);
    let anchor = 'middle';
    if (x < center - 10) anchor = 'end';
    if (x > center + 10) anchor = 'start';
    return `<text x="${x}" y="${y}" font-size="11" fill="#64748b" text-anchor="${anchor}" dominant-baseline="middle" font-weight="bold">${d.dimension}</text>`;
  }).join('');

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${gridHTML}
      <polygon points="${myPoints}" fill="rgba(37, 99, 235, 0.2)" stroke="#2563eb" stroke-width="2"/>
      <polygon points="${compPoints}" fill="rgba(239, 68, 68, 0.2)" stroke="#ef4444" stroke-width="2"/>
      ${labelsHTML}
    </svg>
  `;
}