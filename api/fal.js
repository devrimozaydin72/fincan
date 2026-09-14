/* Vercel sunucu işlevi: /api/fal
 *
 * Anahtarı sayfaya gömmek yerine burada tutuyoruz. Tarayıcı yalnızca
 * bu adrese istek atar; anahtar hiçbir zaman kullanıcıya gitmez.
 *
 * Kurulum (bir kere):
 *   vercel env add GEMINI_API_KEY production
 * ya da Vercel panelinde Settings > Environment Variables.
 *
 * GET  /api/fal  -> {"hazir": true}   anahtar tanımlı mı
 * POST /api/fal  -> {"metin": "..."}  fincanı okur
 */

const MODELLER = ["gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-flash-latest","gemini-2.5-flash"];

const EN_UZUN_SORU   = 60000;      // karakter
const EN_BUYUK_GORSEL = 2800000;   // base64 karakter, yaklaşık 2 MB
const EN_FAZLA_GORSEL = 3;

/* Kaba bir hız sınırı. Sunucu işlevi her an sıfırlanabildiği için bu
   kesin bir koruma değil, yalnızca tek bir kaynaktan gelen seri isteği
   yavaşlatır. Asıl koruma Google tarafındaki ücretsiz kota sınırıdır. */
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

async function gemini(anahtar, model, soru, gorseller){
  const parts = [{text: soru}];
  for(const g of gorseller) parts.push({inline_data:{mime_type:"image/jpeg", data:g}});
  const r = await fetch(
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
  if(!r.ok) throw new Error("gemini " + r.status);
  const j = await r.json();
  const c = j && j.candidates && j.candidates[0];
  const p = (c && c.content && c.content.parts) || [];
  return p.map(x => x.text || "").join("");
}

export default async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");

  const anahtar = process.env.GEMINI_API_KEY || "";

  if(req.method === "GET")
    return res.status(200).json({hazir: !!anahtar});

  if(req.method !== "POST")
    return res.status(405).json({hata:"yalnızca POST"});

  if(!anahtar)
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

  let sonHata = "";
  for(const m of MODELLER){
    try{
      const metin = await gemini(anahtar, m, soru, gorseller);
      if(metin) return res.status(200).json({metin, model:m});
      sonHata = "boş cevap";
    }catch(e){
      sonHata = String(e.message || e);
    }
  }
  return res.status(502).json({hata:"okunamadı", ayrinti:sonHata});
}
