/* Vercel sunucu işlevi: /api/fal
 *
 * Anahtarları sayfaya gömmek yerine burada tutuyoruz. Tarayıcı yalnız
 * bu adrese istek atar; hiçbir anahtar kullanıcıya gitmez ve kullanıcı
 * hiçbir yere üye olmak zorunda kalmaz.
 *
 * BİRDEN FAZLA SAĞLAYICI
 * Tek bir servise bağlı kalmak riskli: ücretsiz kota dolunca ya da
 * servis bir gün cevap vermeyince fal hiç açılmıyor. Artık tanımlı
 * olan bütün sağlayıcılar sırayla deneniyor; biri tutmazsa öbürü
 * devreye giriyor ve kullanıcı bunu hiç fark etmiyor.
 *
 * Kurulum (hangisi varsa onu ekle, hepsi isteğe bağlı):
 *   vercel env add GEMINI_API_KEY production      Google Gemini
 *   vercel env add OPENAI_API_KEY production      OpenAI (ChatGPT)
 *   vercel env add ANTHROPIC_API_KEY production   Anthropic (Claude)
 *   vercel env add OPENROUTER_API_KEY production  OpenRouter (ücretsiz modeller)
 *   vercel env add GROQ_API_KEY production        Groq (ücretsiz kademe)
 *
 * Sıra SAGLAYICI_SIRA ile değiştirilebilir, örneğin:
 *   vercel env add SAGLAYICI_SIRA production      "openrouter,gemini,openai"
 *
 * GET  /api/fal  -> {"hazir": true, "saglayicilar": [...]}
 * POST /api/fal  -> {"metin": "...", "saglayici": "...", "model": "..."}
 */

const EN_UZUN_SORU    = 60000;      // karakter
const EN_BUYUK_GORSEL = 2800000;    // base64 karakter, yaklaşık 2 MB
const EN_FAZLA_GORSEL = 3;
const ZAMAN_ASIMI     = 55000;      // ms

/* Kaba bir hız sınırı. Sunucu işlevi her an sıfırlanabildiği için bu
   kesin bir koruma değil, yalnızca tek bir kaynaktan gelen seri isteği
   yavaşlatır. Asıl koruma sağlayıcıların kendi kota sınırlarıdır.   */
const gecmis = new Map();
const PENCERE = 60 * 1000;
const PENCEREDE_EN_FAZLA = 6;

function hizliMi(kim){
  const simdi = Date.now();
  const liste = (gecmis.get(kim) || []).filter(t => simdi - t < PENCERE);
  liste.push(simdi);
  gecmis.set(kim, liste);
  if(gecmis.size > 500) for(const [k, v] of gecmis)
    if(!v.length || simdi - v[v.length-1] > PENCERE) gecmis.delete(k);
  return liste.length > PENCEREDE_EN_FAZLA;
}

/* Hiçbir sağlayıcı sonsuza kadar bekletmesin. */
async function getir(adres, secenek){
  const kesici = new AbortController();
  const saat = setTimeout(()=>kesici.abort(), ZAMAN_ASIMI);
  try{
    return await fetch(adres, Object.assign({}, secenek, {signal: kesici.signal}));
  } finally { clearTimeout(saat); }
}

/* ══════════════════ SAĞLAYICILAR ══════════════════
   Hepsi aynı sözü veriyor: soruyu ve fincan görsellerini al, JSON
   metni döndür. Görseller base64 JPEG.                            */

async function gemini(anahtar, model, soru, gorseller){
  const parts = [{text: soru}];
  for(const g of gorseller) parts.push({inline_data:{mime_type:"image/jpeg", data:g}});
  const r = await getir(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model +
    ":generateContent?key=" + encodeURIComponent(anahtar),
    {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        contents:[{role:"user", parts}],
        generationConfig:{temperature:1.0, topP:0.95, maxOutputTokens:8192,
                          responseMimeType:"application/json"}
      })
    }
  );
  if(!r.ok) throw new Error("gemini " + r.status + " " + (await r.text()).slice(0,180));
  const j = await r.json();
  const c = j && j.candidates && j.candidates[0];
  const p = (c && c.content && c.content.parts) || [];
  return p.map(x => x.text || "").join("");
}

/* OpenAI ile aynı arayüzü konuşan herkes: OpenAI, OpenRouter, Groq.
   Tek fark adres, anahtar ve model adı.                           */
async function openAiUyumlu(taban, anahtar, model, soru, gorseller, ekBaslik){
  const icerik = [{type:"text", text: soru}];
  for(const g of gorseller)
    icerik.push({type:"image_url", image_url:{url:"data:image/jpeg;base64," + g}});
  const baslik = Object.assign({
    "Content-Type":"application/json",
    "Authorization":"Bearer " + anahtar
  }, ekBaslik || {});
  const r = await getir(taban + "/chat/completions", {
    method:"POST",
    headers: baslik,
    body: JSON.stringify({
      model,
      messages:[{role:"user", content: icerik}],
      temperature: 1.0,
      max_tokens: 8192,
      response_format:{type:"json_object"}
    })
  });
  if(!r.ok) throw new Error(model + " " + r.status + " " + (await r.text()).slice(0,180));
  const j = await r.json();
  const m = j && j.choices && j.choices[0] && j.choices[0].message;
  return (m && (typeof m.content === "string"
    ? m.content
    : (Array.isArray(m.content) ? m.content.map(x => x.text || "").join("") : ""))) || "";
}

async function anthropic(anahtar, model, soru, gorseller){
  const icerik = [];
  for(const g of gorseller)
    icerik.push({type:"image", source:{type:"base64", media_type:"image/jpeg", data:g}});
  icerik.push({type:"text", text: soru});
  const r = await getir("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-api-key": anahtar,
      "anthropic-version":"2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 1.0,
      messages:[{role:"user", content: icerik}]
    })
  });
  if(!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0,180));
  const j = await r.json();
  const p = (j && j.content) || [];
  return p.map(x => x.text || "").join("");
}

/* ── kayıt defteri ──
   Her sağlayıcının anahtarı, model listesi ve çağrısı. Anahtarı
   tanımlı olmayan sağlayıcı listeye hiç girmiyor.                */
const SAGLAYICILAR = {
  gemini: {
    ad: "gemini",
    anahtar: () => process.env.GEMINI_API_KEY || "",
    modeller: ["gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash",
               "gemini-flash-latest","gemini-2.5-flash"],
    cagir: (a, m, s, g) => gemini(a, m, s, g)
  },
  openai: {
    ad: "openai",
    anahtar: () => process.env.OPENAI_API_KEY || "",
    modeller: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini", "gpt-4o-mini"],
    cagir: (a, m, s, g) => openAiUyumlu("https://api.openai.com/v1", a, m, s, g)
  },
  claude: {
    ad: "claude",
    anahtar: () => process.env.ANTHROPIC_API_KEY || "",
    modeller: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
    cagir: (a, m, s, g) => anthropic(a, m, s, g)
  },
  openrouter: {
    ad: "openrouter",
    anahtar: () => process.env.OPENROUTER_API_KEY || "",
    /* :free ekli modeller OpenRouter'ın ücretsiz kademesinde çalışır */
    modeller: ["google/gemini-2.0-flash-exp:free",
               "meta-llama/llama-3.2-11b-vision-instruct:free",
               "qwen/qwen2.5-vl-72b-instruct:free"],
    cagir: (a, m, s, g) => openAiUyumlu("https://openrouter.ai/api/v1", a, m, s, g, {
      "HTTP-Referer": "https://kahve-fali-fincan.vercel.app",
      "X-Title": "Fincan"
    })
  },
  groq: {
    ad: "groq",
    anahtar: () => process.env.GROQ_API_KEY || "",
    modeller: ["meta-llama/llama-4-scout-17b-16e-instruct",
               "llama-3.2-90b-vision-preview"],
    cagir: (a, m, s, g) => openAiUyumlu("https://api.groq.com/openai/v1", a, m, s, g)
  }
};

const VARSAYILAN_SIRA = ["gemini", "openrouter", "groq", "openai", "claude"];

function sira(){
  const ozel = String(process.env.SAGLAYICI_SIRA || "").trim();
  const istenen = ozel
    ? ozel.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : VARSAYILAN_SIRA;
  const gorulen = new Set();
  const cikti = [];
  for(const ad of istenen.concat(VARSAYILAN_SIRA)){
    const s = SAGLAYICILAR[ad];
    if(!s || gorulen.has(ad)) continue;
    gorulen.add(ad);
    if(s.anahtar()) cikti.push(s);
  }
  return cikti;
}

export default async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");

  const hazirlar = sira();

  if(req.method === "GET")
    return res.status(200).json({
      hazir: hazirlar.length > 0,
      saglayicilar: hazirlar.map(s => s.ad)
    });

  if(req.method !== "POST")
    return res.status(405).json({hata:"yalnızca POST"});

  if(!hazirlar.length)
    return res.status(503).json({hata:"anahtar tanımlı değil"});

  const kim = String(req.headers["x-forwarded-for"] || "bilinmiyor").split(",")[0].trim();
  if(hizliMi(kim))
    return res.status(429).json({hata:"çok sık istek"});

  let g = req.body;
  if(typeof g === "string"){ try{ g = JSON.parse(g); }catch(e){ g = null; } }
  if(!g || typeof g !== "object")
    return res.status(400).json({hata:"gövde okunamadı"});

  const soru = typeof g.soru === "string" ? g.soru : "";
  const gorseller = Array.isArray(g.gorseller) ? g.gorseller.slice(0, EN_FAZLA_GORSEL) : [];

  if(!soru || soru.length > EN_UZUN_SORU)
    return res.status(400).json({hata:"istem geçersiz"});
  if(!gorseller.length)
    return res.status(400).json({hata:"görsel yok"});
  for(const b of gorseller)
    if(typeof b !== "string" || !b.length || b.length > EN_BUYUK_GORSEL)
      return res.status(413).json({hata:"görsel çok büyük"});

  /* Sağlayıcıları sırayla dene. Biri tutmazsa öbürüne geç; kullanıcı
     hangi servisin okuduğunu bilmek zorunda değil.                */
  const denenen = [];
  for(const s of hazirlar){
    const anahtar = s.anahtar();
    for(const m of s.modeller){
      try{
        const metin = await s.cagir(anahtar, m, soru, gorseller);
        if(metin) return res.status(200).json({metin, saglayici:s.ad, model:m});
        denenen.push(s.ad + "/" + m + ": boş cevap");
      }catch(e){
        denenen.push(s.ad + "/" + m + ": " + String(e.message || e).slice(0, 120));
      }
    }
  }
  return res.status(502).json({hata:"okunamadı", ayrinti: denenen.slice(-4).join(" | ")});
}
