import { useState, useEffect, useCallback, useRef } from "react";

const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-20250514" };

const LS = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

export default function App() {
  const [tab, setTab] = useState("scan");
  const [col, setCol] = useState(() => LS.get("ps_col", []));
  const [model, setModel] = useState(() => LS.get("ps_model", "sonnet"));
  const [imgData, setImgData] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState("");
  const [result, setResult] = useState(null);
  const [selFinish, setSelFinish] = useState("");
  const [lastPrice, setLastPrice] = useState(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceData, setPriceData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [editPriceLoading, setEditPriceLoading] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const fileRef = useRef();

  useEffect(() => { LS.set("ps_col", col); }, [col]);
  useEffect(() => { LS.set("ps_model", model); }, [model]);

  const toast = useCallback((msg, dur = 2500) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), dur);
  }, []);

  const totalCards = col.reduce((s, c) => s + (c.qty || 1), 0);
  const totalValue = col.reduce((s, c) => s + ((c.price || 0) * (c.qty || 1)), 0);

  // ═══ FILE ═══
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImgData(ev.target.result);
      setResult(null);
      setPriceData(null);
      setLastPrice(null);
    };
    reader.readAsDataURL(f);
  };

  const resetScan = () => {
    setImgData(null); setResult(null); setSelFinish("");
    setLastPrice(null); setPriceData(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  // ═══ ANALYZE ═══
  const analyze = async () => {
    if (!imgData) return;
    setScanning(true);
    setScanStep("Analyse IA en cours...");
    setResult(null); setPriceData(null); setLastPrice(null);

    const b64 = imgData.split(",")[1];
    const prompt = `Tu es un expert Pokémon TCG. Analyse cette photo de carte.
Réponds UNIQUEMENT en JSON valide, sans backticks ni texte:
{"name":"nom sur la carte","name_en":"nom anglais pour recherche prix","number":"numéro ex 025/198","set":"nom extension","rarity":"symbole rareté","finish":"Standard ou Reverse ou Holo","language":"FR ou EN ou JP ou DE"}
Standard=pas brillant. Reverse=fond brillant. Holo=illustration brillante/full-art/ex/rainbow/gold.
Si incertain mettre "?".`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODELS[model],
          max_tokens: 500,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
              { type: "text", text: prompt }
            ]
          }]
        })
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const txt = data.content.map(c => c.text || "").join("");
      const R = JSON.parse(txt.replace(/```json|```/g, "").trim());
      setResult(R);
      setSelFinish(R.finish || "");
      toast("✅ Carte analysée !");

      // Auto price
      setScanStep("Recherche du prix...");
      await doFetchPrice(R.name_en || R.name, R.number);
    } catch (err) {
      console.error(err);
      toast("❌ " + err.message);
    }
    setScanning(false);
  };

  // ═══ PRICE ═══
  const doFetchPrice = async (name, num) => {
    setPriceLoading(true); setPriceData(null); setLastPrice(null);
    try {
      let n = "";
      if (num && num !== "?") n = num.split("/")[0].replace(/^0+/, "");
      let q = `name:"${name}"`;
      if (n) q += ` number:${n}`;
      let resp = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5&select=name,number,set,tcgplayer,cardmarket`);
      let d = await resp.json();
      if (!d.data?.length) {
        resp = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${name}"`)}&pageSize=5&select=name,number,set,tcgplayer,cardmarket`);
        d = await resp.json();
      }
      if (!d.data?.length) { setPriceData({ found: false }); setPriceLoading(false); return; }
      let card = d.data[0];
      if (n) { const x = d.data.find(c => c.number === n); if (x) card = x; }
      const cm = card.cardmarket?.prices, tcg = card.tcgplayer?.prices;
      let pE = null, pU = null;
      if (cm) pE = cm.averageSellPrice || cm.trendPrice || cm.avg1 || cm.lowPrice || null;
      if (tcg) { const v = tcg.holofoil || tcg.reverseHolofoil || tcg.normal || Object.values(tcg)[0]; if (v) pU = v.market || v.mid || v.low || null; }
      const pd = { found: true, pE, pU, cardName: card.name, cardNum: card.number, setName: card.set?.name };
      setPriceData(pd); setLastPrice(pd);
    } catch { setPriceData({ found: false }); }
    setPriceLoading(false);
  };

  // ═══ SAVE ═══
  const saveCard = () => {
    if (!result?.name) { toast("⚠️ Nom requis"); return; }
    const card = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      name: result.name, number: result.number || "", rarity: result.rarity || "",
      set: result.set || "", finish: selFinish || "Standard",
      qty: parseInt(document.getElementById("rQty")?.value) || 1,
      language: result.language || "FR",
      date: new Date().toISOString().split("T")[0],
      price: lastPrice?.pE || lastPrice?.pU || null
    };
    setCol(prev => [...prev, card]);
    toast("✅ " + card.name + " ajoutée !");
    resetScan();
  };

  // ═══ COLLECTION ═══
  const filtered = col.filter(c => {
    if (filter !== "all" && c.finish !== filter) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) &&
      !(c.set || "").toLowerCase().includes(search.toLowerCase()) &&
      !(c.number || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.name.localeCompare(b.name));

  const deleteCard = (id) => { if (confirm("Supprimer ?")) setCol(prev => prev.filter(c => c.id !== id)); };

  // ═══ EDIT ═══
  const openEdit = (id) => {
    const c = col.find(x => x.id === id);
    if (!c) return;
    setEditId(id);
    setEditData({ ...c });
  };
  const saveEdit = () => {
    setCol(prev => prev.map(c => c.id === editId ? { ...editData } : c));
    setEditId(null); toast("✅ Modifiée");
  };
  const fetchEditPrice = async () => {
    if (!editData.name) return;
    setEditPriceLoading(true);
    try {
      let n = "";
      if (editData.number && editData.number !== "?") n = editData.number.split("/")[0].replace(/^0+/, "");
      let q = `name:"${editData.name}"`;
      if (n) q += ` number:${n}`;
      const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5&select=name,number,tcgplayer,cardmarket`);
      const d = await r.json();
      if (d.data?.length) {
        let card = d.data[0];
        if (n) { const x = d.data.find(c => c.number === n); if (x) card = x; }
        const cm = card.cardmarket?.prices, tcg = card.tcgplayer?.prices;
        let p = null;
        if (cm) p = cm.averageSellPrice || cm.trendPrice || cm.avg1;
        if (!p && tcg) { const v = tcg.holofoil || tcg.reverseHolofoil || tcg.normal || Object.values(tcg)[0]; if (v) p = v.market || v.mid; }
        if (p) { setEditData(prev => ({ ...prev, price: p })); toast("✅ " + p.toFixed(2) + " €"); }
        else toast("Non disponible");
      } else toast("Non trouvé");
    } catch { toast("Erreur"); }
    setEditPriceLoading(false);
  };

  // ═══ REFRESH PRICES ═══
  const refreshAll = async () => {
    if (!col.length) return;
    toast("🔄 Actualisation...", 4000);
    let updated = 0;
    const newCol = [...col];
    for (let i = 0; i < newCol.length; i++) {
      try {
        const c = newCol[i];
        let n = "";
        if (c.number && c.number !== "?") n = c.number.split("/")[0].replace(/^0+/, "");
        let q = `name:"${c.name}"`;
        if (n) q += ` number:${n}`;
        const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=3&select=name,number,tcgplayer,cardmarket`);
        const d = await r.json();
        if (d.data?.length) {
          let card = d.data[0];
          if (n) { const x = d.data.find(x => x.number === n); if (x) card = x; }
          const cm = card.cardmarket?.prices, tcg = card.tcgplayer?.prices;
          let p = null;
          if (cm) p = cm.averageSellPrice || cm.trendPrice || cm.avg1;
          if (!p && tcg) { const v = tcg.holofoil || tcg.reverseHolofoil || tcg.normal || Object.values(tcg)[0]; if (v) p = v.market || v.mid; }
          if (p) { newCol[i] = { ...newCol[i], price: p }; updated++; }
        }
        if (i < newCol.length - 1) await new Promise(r => setTimeout(r, 350));
      } catch {}
    }
    setCol(newCol);
    toast(`✅ ${updated}/${col.length} actualisés`);
  };

  // ═══ EXPORT ═══
  const exportExcel = async () => {
    if (!col.length) return;
    const XLSX = await import("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    const rows = col.map(c => ({
      Nom: c.name, Numéro: c.number, Extension: c.set, Rareté: c.rarity,
      Finition: c.finish, Qté: c.qty || 1, Langue: c.language || "FR",
      "Prix €": c.price ? c.price.toFixed(2) : "", "Valeur €": c.price ? (c.price * (c.qty || 1)).toFixed(2) : ""
    }));
    const ws = window.XLSX.utils.json_to_sheet(rows);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Collection");
    window.XLSX.writeFile(wb, `pokescan_${new Date().toISOString().split("T")[0]}.xlsx`);
    toast("📥 Exporté !");
  };

  const exportJSON = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(col, null, 2)], { type: "application/json" }));
    a.download = `pokescan_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
  };

  const importJSON = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target.result);
        if (!Array.isArray(d)) throw 0;
        if (confirm(`Importer ${d.length} cartes ?`)) {
          setCol(prev => [...prev, ...d]);
          toast(`✅ ${d.length} importées`);
        }
      } catch { toast("Fichier invalide"); }
    };
    r.readAsText(f);
  };

  // ═══ STATS DATA ═══
  const sets = [...new Set(col.map(c => c.set).filter(Boolean))];
  const holos = col.filter(c => c.finish === "Holo").length;
  const setCounts = {};
  col.forEach(c => { const s = c.set || "?"; setCounts[s] = (setCounts[s] || 0) + (c.qty || 1); });
  const topSets = Object.entries(setCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxSet = Math.max(...topSets.map(s => s[1]), 1);
  const finCounts = { Standard: 0, Reverse: 0, Holo: 0 };
  col.forEach(c => { finCounts[c.finish || "Standard"] += (c.qty || 1); });
  const maxFin = Math.max(...Object.values(finCounts), 1);
  const topVal = col.filter(c => c.price).sort((a, b) => (b.price * (b.qty || 1)) - (a.price * (a.qty || 1))).slice(0, 5);
  const maxTopVal = topVal.length ? topVal[0].price * (topVal[0].qty || 1) : 1;

  const finColors = { Standard: "#636e80", Reverse: "#48dbfb", Holo: "#feca57" };

  const esc = (s) => s || "";

  // ═══ STYLES ═══
  const S = {
    app: { fontFamily: "'Segoe UI',system-ui,sans-serif", background: "#08090e", color: "#edf0f7", minHeight: "100dvh" },
    header: { position: "sticky", top: 0, zIndex: 100, background: "rgba(8,9,14,0.9)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" },
    logo: { fontWeight: 900, fontSize: "1.4rem", letterSpacing: 3, background: "linear-gradient(135deg,#ff4757,#feca57,#48dbfb)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
    hVal: { fontSize: "0.7rem", color: "#2ed573", fontWeight: 600 },
    tabs: { display: "flex", background: "rgba(15,17,24,0.95)", borderBottom: "1px solid rgba(255,255,255,0.06)" },
    tab: (a) => ({ flex: 1, padding: "14px 8px", textAlign: "center", fontSize: "0.7rem", fontWeight: 700, letterSpacing: 1, cursor: "pointer", color: a ? "#ff4757" : "#454a6b", borderBottom: a ? "2px solid #ff4757" : "2px solid transparent", transition: "all 0.2s" }),
    page: { padding: 20, paddingBottom: 120 },
    // Scan
    scanZone: { background: "#1c1f2e", border: "2px dashed rgba(255,71,87,0.3)", borderRadius: 20, padding: "50px 20px", textAlign: "center", cursor: "pointer" },
    prevWrap: { position: "relative", maxWidth: 280, margin: "16px auto" },
    prevImg: { width: "100%", borderRadius: 12, display: "block" },
    corner: (pos) => {
      const base = { position: "absolute", width: 22, height: 22 };
      const brd = "2px solid #ff4757";
      if (pos === "tl") return { ...base, top: "6%", left: "6%", borderTop: brd, borderLeft: brd, borderRadius: "4px 0 0 0" };
      if (pos === "tr") return { ...base, top: "6%", right: "6%", borderTop: brd, borderRight: brd, borderRadius: "0 4px 0 0" };
      if (pos === "bl") return { ...base, bottom: "6%", left: "6%", borderBottom: brd, borderLeft: brd, borderRadius: "0 0 0 4px" };
      return { ...base, bottom: "6%", right: "6%", borderBottom: brd, borderRight: brd, borderRadius: "0 0 4px 0" };
    },
    frameLabel: { position: "absolute", bottom: "-20px", left: "50%", transform: "translateX(-50%)", fontSize: "0.6rem", color: "#ff4757", letterSpacing: 2, fontWeight: 700, whiteSpace: "nowrap" },
    closeBtn: { position: "absolute", top: -8, right: -8, width: 28, height: 28, borderRadius: "50%", background: "#ff4757", border: "none", color: "#fff", fontSize: "0.85rem", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
    btnPrimary: { width: "100%", marginTop: 16, padding: 16, background: "#ff4757", color: "#fff", border: "none", borderRadius: 12, fontWeight: 800, fontSize: "0.95rem", letterSpacing: 2, cursor: "pointer" },
    btnSave: { width: "100%", marginTop: 12, padding: 16, background: "linear-gradient(135deg,#2ed573,#20bf6b)", color: "#fff", border: "none", borderRadius: 12, fontWeight: 800, fontSize: "0.9rem", letterSpacing: 2, cursor: "pointer" },
    btnGhost: { width: "100%", padding: 12, background: "#1c1f2e", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 12, color: "#6c7293", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", textAlign: "center", marginTop: 12 },
    btnPrice: { width: "100%", padding: 12, background: "rgba(46,213,115,0.06)", border: "1px solid rgba(46,213,115,0.2)", borderRadius: 10, color: "#2ed573", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer", marginTop: 8 },
    result: { marginTop: 20, background: "#1c1f2e", borderRadius: 16, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" },
    resHead: { padding: "14px 18px", background: "linear-gradient(135deg,rgba(255,71,87,0.08),rgba(254,202,87,0.04))", borderBottom: "1px solid rgba(255,255,255,0.06)", fontWeight: 800, fontSize: "0.8rem", letterSpacing: 1, color: "#2ed573" },
    resBody: { padding: 18 },
    fgLabel: { fontSize: "0.65rem", fontWeight: 700, color: "#454a6b", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 },
    fgInput: { width: "100%", padding: "11px 14px", background: "#0f1118", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, color: "#edf0f7", fontSize: "0.95rem", outline: "none", fontFamily: "inherit" },
    finBtn: (a, v) => ({ flex: 1, padding: "11px 6px", borderRadius: 10, border: `2px solid ${a ? finColors[v] || "#636e80" : "rgba(255,255,255,0.08)"}`, background: a ? `${finColors[v]}18` : "#0f1118", color: a ? finColors[v] || "#edf0f7" : "#454a6b", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer", textAlign: "center" }),
    priceBox: { marginTop: 14, padding: 14, background: "rgba(46,213,115,0.04)", border: "1px solid rgba(46,213,115,0.12)", borderRadius: 12 },
    // Collection
    cItem: { display: "flex", alignItems: "center", gap: 12, padding: 14, background: "#1c1f2e", borderRadius: 12, border: "1px solid rgba(255,255,255,0.05)", cursor: "pointer", marginBottom: 6 },
    cDot: (f) => ({ width: 8, height: 8, borderRadius: "50%", background: finColors[f] || "#636e80", boxShadow: f !== "Standard" ? `0 0 8px ${finColors[f]}66` : "none", flexShrink: 0 }),
    cPrice: { fontSize: "0.75rem", fontWeight: 700, color: "#2ed573", padding: "3px 8px", background: "rgba(46,213,115,0.08)", borderRadius: 6, whiteSpace: "nowrap" },
    // Stats
    sCard: (c) => ({ background: "#1c1f2e", borderRadius: 14, padding: "18px 14px", textAlign: "center", border: "1px solid rgba(255,255,255,0.05)", borderTop: `2px solid ${c}` }),
    barTrack: { flex: 1, height: 18, background: "#08090e", borderRadius: 4, overflow: "hidden" },
    barFill: (w, c) => ({ height: "100%", width: `${w}%`, borderRadius: 4, background: c, transition: "width 0.5s" }),
    // Modal
    modalBg: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 150, display: "flex", justifyContent: "center", alignItems: "flex-end", backdropFilter: "blur(4px)" },
    modalBox: { background: "#0f1118", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, maxHeight: "80vh", overflowY: "auto", padding: 22, borderTop: "1px solid rgba(255,255,255,0.06)" },
    toast: { position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: "#2ed573", color: "#fff", padding: "10px 22px", borderRadius: 12, fontWeight: 700, fontSize: "0.8rem", zIndex: 300, boxShadow: "0 4px 20px rgba(46,213,115,0.3)" },
    chip: (a) => ({ padding: "6px 14px", borderRadius: 20, fontSize: "0.72rem", fontWeight: 700, cursor: "pointer", border: a ? "1px solid #ff4757" : "1px solid rgba(255,255,255,0.08)", background: a ? "rgba(255,71,87,0.1)" : "#1c1f2e", color: a ? "#ff4757" : "#454a6b" }),
  };

  // ═══ MANUAL ADD ═══
  const manualAdd = () => {
    setResult({ name: "", number: "", rarity: "", set: "", finish: "", language: "FR", name_en: "" });
    setSelFinish(""); setLastPrice(null); setPriceData(null);
  };

  return (
    <div style={S.app}>
      {/* HEADER */}
      <div style={S.header}>
        <div style={S.logo}>POKÉSCAN</div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 800, fontSize: "1.1rem", color: "#feca57" }}>{totalCards}</div>
          <div style={{ fontSize: "0.65rem", color: "#6c7293" }}>{col.length} uniques</div>
          {totalValue > 0 && <div style={S.hVal}>💰 {totalValue.toFixed(2)} €</div>}
        </div>
      </div>

      {/* TABS */}
      <div style={S.tabs}>
        {[["scan", "📷", "SCAN"], ["col", "🗂", "CARTES"], ["stats", "📊", "STATS"], ["cfg", "⚙", "CONFIG"]].map(([k, ico, lbl]) => (
          <div key={k} style={S.tab(tab === k)} onClick={() => setTab(k)}>
            <div style={{ fontSize: "1.15rem" }}>{ico}</div>{lbl}
          </div>
        ))}
      </div>

      {/* ═══ SCAN ═══ */}
      {tab === "scan" && (
        <div style={S.page}>
          {!imgData && (
            <div style={S.scanZone} onClick={() => fileRef.current?.click()}>
              <div style={{ fontSize: "2.5rem", marginBottom: 12 }}>📸</div>
              <div style={{ color: "#6c7293", fontSize: "0.95rem", fontWeight: 600 }}>Photographier une carte</div>
              <div style={{ color: "#454a6b", fontSize: "0.8rem", marginTop: 4 }}>Cadrez la carte entière</div>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFile} />

          {imgData && (
            <div style={S.prevWrap}>
              <img src={imgData} alt="" style={S.prevImg} />
              <div style={S.corner("tl")} /><div style={S.corner("tr")} />
              <div style={S.corner("bl")} /><div style={S.corner("br")} />
              <div style={S.frameLabel}>CARTE DÉTECTÉE</div>
              <button style={S.closeBtn} onClick={resetScan}>✕</button>
            </div>
          )}

          {imgData && !scanning && !result && (
            <button style={S.btnPrimary} onClick={analyze}>⚡ ANALYSER</button>
          )}

          {scanning && (
            <div style={{ textAlign: "center", marginTop: 20 }}>
              <div style={{ width: 44, height: 44, border: "3px solid #161822", borderTopColor: "#ff4757", borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto 12px" }} />
              <div style={{ color: "#6c7293", fontSize: "0.8rem", letterSpacing: 1 }}>{scanStep}</div>
            </div>
          )}

          {result && (
            <div style={S.result}>
              <div style={S.resHead}>{result.name ? "✓ CARTE IDENTIFIÉE" : "✏ AJOUT MANUEL"}</div>
              <div style={S.resBody}>
                <div style={{ marginBottom: 14 }}>
                  <div style={S.fgLabel}>NOM</div>
                  <input style={S.fgInput} value={result.name || ""} onChange={e => setResult(r => ({ ...r, name: e.target.value }))} placeholder="Pikachu" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  <div><div style={S.fgLabel}>NUMÉRO</div><input style={S.fgInput} value={result.number || ""} onChange={e => setResult(r => ({ ...r, number: e.target.value }))} /></div>
                  <div><div style={S.fgLabel}>RARETÉ</div><input style={S.fgInput} value={result.rarity || ""} onChange={e => setResult(r => ({ ...r, rarity: e.target.value }))} /></div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={S.fgLabel}>EXTENSION</div>
                  <input style={S.fgInput} value={result.set || ""} onChange={e => setResult(r => ({ ...r, set: e.target.value }))} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={S.fgLabel}>FINITION</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    {["Standard", "Reverse", "Holo"].map(f => (
                      <button key={f} style={S.finBtn(selFinish === f, f)} onClick={() => setSelFinish(f)}>
                        {f === "Holo" ? "Holo ✦" : f}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  <div><div style={S.fgLabel}>QUANTITÉ</div><input id="rQty" style={S.fgInput} type="number" defaultValue={1} min={1} /></div>
                  <div><div style={S.fgLabel}>LANGUE</div>
                    <select style={S.fgInput} value={result.language || "FR"} onChange={e => setResult(r => ({ ...r, language: e.target.value }))}>
                      {["FR", "EN", "JP", "DE"].map(l => <option key={l}>{l}</option>)}
                    </select>
                  </div>
                </div>

                {(priceData || priceLoading) && (
                  <div style={S.priceBox}>
                    <div style={{ fontSize: "0.65rem", color: "#2ed573", letterSpacing: 1.5, fontWeight: 700, marginBottom: 8 }}>💰 PRIX DU MARCHÉ</div>
                    {priceLoading && <div style={{ color: "#454a6b", fontSize: "0.8rem" }}>⏳ Recherche...</div>}
                    {priceData && !priceLoading && (
                      <>
                        {priceData.pE != null && <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span style={{ color: "#6c7293" }}>Cardmarket</span><span style={{ fontWeight: 700, color: "#2ed573" }}>{priceData.pE.toFixed(2)} €</span></div>}
                        {priceData.pU != null && <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span style={{ color: "#6c7293" }}>TCGPlayer</span><span style={{ fontWeight: 700, color: "#2ed573" }}>${priceData.pU.toFixed(2)}</span></div>}
                        {!priceData.pE && !priceData.pU && <div style={{ color: "#454a6b", fontStyle: "italic" }}>Non disponible</div>}
                        {priceData.cardName && <div style={{ fontSize: "0.68rem", color: "#454a6b", marginTop: 4 }}>→ {priceData.cardName} {priceData.cardNum} · {priceData.setName}</div>}
                      </>
                    )}
                  </div>
                )}

                <button style={S.btnPrice} onClick={() => doFetchPrice(result.name_en || result.name, result.number)}>🔍 Rechercher le prix</button>
                <button style={S.btnSave} onClick={saveCard}>ENREGISTRER</button>
              </div>
            </div>
          )}

          <button style={S.btnGhost} onClick={manualAdd}>＋ Ajout manuel</button>
        </div>
      )}

      {/* ═══ COLLECTION ═══ */}
      {tab === "col" && (
        <div style={S.page}>
          <div style={{ position: "relative", marginBottom: 14 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#454a6b", pointerEvents: "none" }}>🔍</span>
            <input style={{ ...S.fgInput, paddingLeft: 38, background: "#1c1f2e" }} placeholder="Rechercher..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {[["all", "Toutes"], ["Standard", "Standard"], ["Reverse", "Reverse"], ["Holo", "Holo ✦"]].map(([k, l]) => (
              <div key={k} style={S.chip(filter === k)} onClick={() => setFilter(k)}>{l}</div>
            ))}
          </div>
          {!filtered.length && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#454a6b" }}>
              <div style={{ fontSize: "2.5rem", opacity: 0.25, marginBottom: 10 }}>🃏</div>
              <div style={{ fontSize: "0.85rem" }}>{col.length ? "Aucun résultat" : "Scannez votre première carte"}</div>
            </div>
          )}
          {filtered.map(c => (
            <div key={c.id} style={S.cItem} onClick={() => openEdit(c.id)}>
              <div style={S.cDot(c.finish)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: "0.95rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                <div style={{ fontSize: "0.73rem", color: "#6c7293", marginTop: 1 }}>{esc(c.set)} · {c.language || "FR"}</div>
              </div>
              <div style={{ fontSize: "0.72rem", color: "#454a6b", whiteSpace: "nowrap", fontWeight: 600 }}>{esc(c.number)}</div>
              {c.price && <div style={S.cPrice}>{c.price.toFixed(2)}€</div>}
              {c.qty > 1 && <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#ff4757", padding: "2px 7px", background: "rgba(255,71,87,0.1)", borderRadius: 8 }}>×{c.qty}</div>}
              <button style={{ background: "none", border: "none", color: "#454a6b", fontSize: "0.85rem", cursor: "pointer", padding: 4, opacity: 0.5 }} onClick={e => { e.stopPropagation(); deleteCard(c.id); }}>🗑</button>
            </div>
          ))}
        </div>
      )}

      {/* ═══ STATS ═══ */}
      {tab === "stats" && (
        <div style={S.page}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
            {[[totalCards, "Total cartes", "#ff4757"], [totalValue.toFixed(2) + "€", "Valeur totale", "#2ed573"], [sets.length, "Extensions", "#48dbfb"], [holos, "Holos", "#feca57"]].map(([v, l, c], i) => (
              <div key={i} style={S.sCard(c)}>
                <div style={{ fontWeight: 800, fontSize: "1.4rem", color: c }}>{v}</div>
                <div style={{ fontSize: "0.6rem", color: "#454a6b", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 4 }}>{l}</div>
              </div>
            ))}
          </div>

          {topVal.length > 0 && (
            <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 16, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#454a6b", letterSpacing: 1.5, marginBottom: 12 }}>💎 TOP VALEUR</div>
              {topVal.map((c, i) => { const v = c.price * (c.qty || 1); return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <div style={{ fontSize: "0.75rem", color: "#6c7293", minWidth: 80, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                  <div style={S.barTrack}><div style={S.barFill(v / maxTopVal * 100, "linear-gradient(90deg,#2ed573,#7bed9f)")} /></div>
                  <div style={{ fontSize: "0.72rem", color: "#2ed573", minWidth: 50, textAlign: "right", fontWeight: 700 }}>{v.toFixed(2)}€</div>
                </div>
              ); })}
            </div>
          )}

          {topSets.length > 0 && (
            <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 16, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#454a6b", letterSpacing: 1.5, marginBottom: 12 }}>PAR EXTENSION</div>
              {topSets.map(([n, ct], i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <div style={{ fontSize: "0.75rem", color: "#6c7293", minWidth: 80, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</div>
                  <div style={S.barTrack}><div style={S.barFill(ct / maxSet * 100, "linear-gradient(90deg,#ff4757,#ff6b81)")} /></div>
                  <div style={{ fontSize: "0.72rem", color: "#6c7293", minWidth: 28, textAlign: "right", fontWeight: 700 }}>{ct}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 16, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#454a6b", letterSpacing: 1.5, marginBottom: 12 }}>PAR FINITION</div>
            {Object.entries(finCounts).map(([n, ct], i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <div style={{ fontSize: "0.75rem", color: "#6c7293", minWidth: 80 }}>{n}</div>
                <div style={S.barTrack}><div style={S.barFill(ct / maxFin * 100, finColors[n])} /></div>
                <div style={{ fontSize: "0.72rem", color: "#6c7293", minWidth: 28, textAlign: "right", fontWeight: 700 }}>{ct}</div>
              </div>
            ))}
          </div>

          <button style={{ width: "100%", padding: 13, background: "rgba(46,213,115,0.06)", border: "1px solid rgba(46,213,115,0.2)", borderRadius: 12, color: "#2ed573", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer", marginTop: 8 }} onClick={refreshAll}>🔄 ACTUALISER LES PRIX</button>
          <button style={{ width: "100%", padding: 14, background: "linear-gradient(135deg,#3742fa,#5352ed)", color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: "0.8rem", cursor: "pointer", marginTop: 8, letterSpacing: 1 }} onClick={exportExcel}>📥 EXPORTER EXCEL</button>
        </div>
      )}

      {/* ═══ CONFIG ═══ */}
      {tab === "cfg" && (
        <div style={S.page}>
          <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 18, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>🤖 Modèle IA</div>
            <div style={{ fontSize: "0.8rem", color: "#6c7293", marginBottom: 12 }}>Le scan utilise l'API Claude intégrée — aucune clé nécessaire.</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[["haiku", "⚡ Haiku", "Rapide"], ["sonnet", "🎯 Sonnet", "Précis"]].map(([k, n, d]) => (
                <div key={k} onClick={() => setModel(k)} style={{ flex: 1, padding: "14px 8px", borderRadius: 12, border: model === k ? "2px solid #ff4757" : "2px solid rgba(255,255,255,0.08)", background: model === k ? "rgba(255,71,87,0.06)" : "#0f1118", color: model === k ? "#ff4757" : "#454a6b", cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>{n}</div>
                  <div style={{ fontSize: "0.7rem", opacity: 0.6, marginTop: 2 }}>{d}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 18, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>💰 Prix automatiques</div>
            <div style={{ fontSize: "0.8rem", color: "#6c7293" }}>Gratuit via pokemontcg.io — Cardmarket EUR + TCGPlayer USD.</div>
          </div>
          <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 18, marginBottom: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>📋 Sauvegarde</div>
            <button style={S.btnGhost} onClick={exportJSON}>📤 Exporter JSON</button>
            <button style={{ ...S.btnGhost, marginTop: 8 }} onClick={() => document.getElementById("impJ2").click()}>📥 Importer JSON</button>
            <input id="impJ2" type="file" accept=".json" style={{ display: "none" }} onChange={importJSON} />
          </div>
          <div style={{ background: "#1c1f2e", borderRadius: 14, padding: 18, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>🗑 Zone Danger</div>
            <button style={{ width: "100%", padding: 12, background: "rgba(255,71,87,0.06)", border: "1px solid rgba(255,71,87,0.3)", borderRadius: 12, color: "#ff4757", fontWeight: 700, cursor: "pointer" }} onClick={() => { if (confirm("Tout supprimer ?")) { setCol([]); toast("Supprimé"); } }}>Supprimer la collection</button>
          </div>
        </div>
      )}

      {/* ═══ EDIT MODAL ═══ */}
      {editId && (
        <div style={S.modalBg} onClick={e => { if (e.target === e.currentTarget) setEditId(null); }}>
          <div style={S.modalBox}>
            <div style={{ fontWeight: 800, fontSize: "1rem", letterSpacing: 1, marginBottom: 18, display: "flex", justifyContent: "space-between" }}>
              MODIFIER <button style={{ background: "none", border: "none", color: "#454a6b", fontSize: "1.3rem", cursor: "pointer" }} onClick={() => setEditId(null)}>✕</button>
            </div>
            <div style={{ marginBottom: 14 }}><div style={S.fgLabel}>NOM</div><input style={S.fgInput} value={editData.name || ""} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div><div style={S.fgLabel}>NUMÉRO</div><input style={S.fgInput} value={editData.number || ""} onChange={e => setEditData(d => ({ ...d, number: e.target.value }))} /></div>
              <div><div style={S.fgLabel}>RARETÉ</div><input style={S.fgInput} value={editData.rarity || ""} onChange={e => setEditData(d => ({ ...d, rarity: e.target.value }))} /></div>
            </div>
            <div style={{ marginBottom: 14 }}><div style={S.fgLabel}>EXTENSION</div><input style={S.fgInput} value={editData.set || ""} onChange={e => setEditData(d => ({ ...d, set: e.target.value }))} /></div>
            <div style={{ marginBottom: 14 }}>
              <div style={S.fgLabel}>FINITION</div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                {["Standard", "Reverse", "Holo"].map(f => (
                  <button key={f} style={S.finBtn(editData.finish === f, f)} onClick={() => setEditData(d => ({ ...d, finish: f }))}>{f === "Holo" ? "Holo ✦" : f}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div><div style={S.fgLabel}>QUANTITÉ</div><input style={S.fgInput} type="number" min={1} value={editData.qty || 1} onChange={e => setEditData(d => ({ ...d, qty: parseInt(e.target.value) || 1 }))} /></div>
              <div><div style={S.fgLabel}>LANGUE</div>
                <select style={S.fgInput} value={editData.language || "FR"} onChange={e => setEditData(d => ({ ...d, language: e.target.value }))}>
                  {["FR", "EN", "JP", "DE"].map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div><div style={S.fgLabel}>PRIX (€)</div><input style={S.fgInput} type="number" step="0.01" min={0} value={editData.price || ""} onChange={e => setEditData(d => ({ ...d, price: parseFloat(e.target.value) || null }))} placeholder="Auto" /></div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button style={{ ...S.btnPrice, margin: 0, padding: 11 }} onClick={fetchEditPrice} disabled={editPriceLoading}>
                  {editPriceLoading ? "⏳" : "🔍 Auto"}
                </button>
              </div>
            </div>
            <button style={S.btnSave} onClick={saveEdit}>SAUVEGARDER</button>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toastMsg && <div style={S.toast}>{toastMsg}</div>}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
