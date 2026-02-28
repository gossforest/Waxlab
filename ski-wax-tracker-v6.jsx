import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';

// ─── SUPABASE + STORAGE ───────────────────────────────────────────────────────
const SUPABASE_URL      = window.WAXLAB_CONFIG?.SUPABASE_URL      || "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = window.WAXLAB_CONFIG?.SUPABASE_ANON_KEY || "YOUR_SUPABASE_ANON_KEY";
const GOOGLE_CLIENT_ID  = window.WAXLAB_CONFIG?.GOOGLE_CLIENT_ID  || "";
const supabaseConfigured = SUPABASE_URL !== "YOUR_SUPABASE_URL";
const db = supabaseConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function lsGet(k)     { try { const v=localStorage.getItem(k); return v?JSON.parse(v):null; } catch { return null; } }
function lsSet(k,v)   { try { localStorage.setItem(k,JSON.stringify(v)); } catch {} }

async function loadTeamEvents(teamCode) {
  if (db) {
    try {
      const { data, error } = await db.from("waxlab_events").select("data").eq("team_code", teamCode);
      if (error) throw error;
      return (data||[]).map(r=>r.data);
    } catch(e) { console.warn("loadEvents:", e.message); }
  }
  return lsGet(`waxlab:events:${teamCode}`) || [];
}

// Load events from ALL teams for cross-team prediction
async function loadAllEvents() {
  if (db) {
    try {
      const { data, error } = await db.from("waxlab_events").select("data");
      if (error) throw error;
      return (data||[]).map(r=>r.data);
    } catch(e) { console.warn("loadAllEvents:", e.message); }
  }
  // Fallback: gather all team codes seen in localStorage
  const allKeys = Object.keys(localStorage).filter(k => k.startsWith("waxlab:events:"));
  return allKeys.flatMap(k => { try { return JSON.parse(localStorage.getItem(k))||[]; } catch { return []; } });
}
async function saveEvent(teamCode, event) {
  if (db) {
    try {
      await db.from("waxlab_events").upsert(
        { id:event.id, team_code:teamCode, data:event, updated_at:new Date().toISOString() },
        { onConflict:"id" }
      );
      return true;
    } catch(e) { console.warn("saveEvent:", e.message); return false; }
  }
  const ex = lsGet(`waxlab:events:${teamCode}`) || [];
  lsSet(`waxlab:events:${teamCode}`, ex.find(e=>e.id===event.id) ? ex.map(e=>e.id===event.id?event:e) : [...ex,event]);
  return true;
}
async function deleteEventDB(teamCode, eventId) {
  if (db) { try { await db.from("waxlab_events").delete().eq("id",eventId); return; } catch {} }
  const ex = lsGet(`waxlab:events:${teamCode}`) || [];
  lsSet(`waxlab:events:${teamCode}`, ex.filter(e=>e.id!==eventId));
}
async function loadVocab() {
  if (db) {
    try {
      const { data, error } = await db.from("waxlab_vocab").select("category,terms");
      if (error) throw error;
      const v={}; (data||[]).forEach(r=>{ v[r.category]=r.terms; }); return v;
    } catch(e) { console.warn("loadVocab:", e.message); }
  }
  return lsGet("waxlab:vocab:global") || {};
}
async function addVocabTerms(category, newTerms) {
  if (!newTerms?.length) return;
  if (db) {
    try {
      const { data } = await db.from("waxlab_vocab").select("terms").eq("category",category).single();
      const merged = [...new Set([...(data?.terms||[]),...newTerms])].sort();
      await db.from("waxlab_vocab").upsert({ category, terms:merged }, { onConflict:"category" });
      return;
    } catch(e) { console.warn("addVocabTerms:", e.message); }
  }
  const vocab = lsGet("waxlab:vocab:global") || {};
  vocab[category] = [...new Set([...(vocab[category]||[]),...newTerms])].sort();
  lsSet("waxlab:vocab:global", vocab);
}
function subscribeToTeam(teamCode, onEventChange, onVocabChange, onFleetChange) {
  if (!db) return () => {};
  const evCh = db.channel(`waxlab_events:${teamCode}`)
    .on("postgres_changes",{ event:"*", schema:"public", table:"waxlab_events", filter:`team_code=eq.${teamCode}` },
      p => { if(p.eventType==="DELETE") onEventChange({type:"delete",id:p.old?.id}); else onEventChange({type:"upsert",event:p.new?.data}); })
    .subscribe();
  const vocabCh = db.channel("waxlab_vocab:global")
    .on("postgres_changes",{ event:"*", schema:"public", table:"waxlab_vocab" },
      p => { if(p.new) onVocabChange(p.new.category, p.new.terms); })
    .subscribe();
  const fleetCh = db.channel(`waxlab_fleets:${teamCode}`)
    .on("postgres_changes",{ event:"*", schema:"public", table:"waxlab_fleets", filter:`team_code=eq.${teamCode}` },
      p => { if(p.new?.data && onFleetChange) onFleetChange(p.new.data); })
    .subscribe();
  return () => { db.removeChannel(evCh); db.removeChannel(vocabCh); db.removeChannel(fleetCh); };
}


// ─── PHOTO STORAGE ────────────────────────────────────────────────────────────
// Strategy: Supabase Storage when configured, IndexedDB fallback for local-only mode.
// Thumbnails (100×100 base64) are always stored inline on ski.photos[] for instant
// preview without a network fetch. Full images live in storage.

const IDB_DB_NAME  = "waxlab-photos";
const IDB_STORE    = "blobs";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbPut(key, blob) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}
async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  });
}

// Resize + encode image using Canvas. Used for both thumbnails and compressed uploads.
// thumbSize: square crop dimension (null = no crop, use maxLong for longest side)
// maxLong: max pixels on longest side (null = no resize)
// quality: JPEG quality 0–1
function resizeImage(file, { thumbSize=null, maxLong=null, quality=0.80 }) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (thumbSize) {
        // Square cover crop
        const scale = Math.max(thumbSize / w, thumbSize / h);
        const sw = w * scale, sh = h * scale;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = thumbSize;
        canvas.getContext("2d").drawImage(img, (thumbSize-sw)/2, (thumbSize-sh)/2, sw, sh);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } else {
        // Proportional resize to maxLong
        if (maxLong && Math.max(w, h) > maxLong) {
          const scale = maxLong / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => resolve(blob), "image/jpeg", quality);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function generateThumb(file) {
  return resizeImage(file, { thumbSize: 120, quality: 0.75 });
}

async function compressForUpload(file) {
  // Target ≤ 150 KB: resize longest side to 1200px at JPEG q=0.78
  // Typical result: 80–160 KB vs 4–6 MB original — 30–60× smaller
  const blob = await resizeImage(file, { maxLong: 1200, quality: 0.78 });
  if (!blob) return file; // fall back to original if canvas fails
  return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
}

async function uploadPhoto(teamCode, eventId, skiId, file) {
  const photoId = uid();
  // Compress before upload: ~5 MB → ~120 KB, preserving enough detail for ski analysis
  const [compressed, thumb] = await Promise.all([
    compressForUpload(file),
    generateThumb(file),
  ]);
  const path = `${teamCode}/${eventId}/${skiId}/${photoId}.jpg`;

  if (supabaseConfigured) {
    try {
      const { error } = await db.storage
        .from("waxlab-photos")
        .upload(path, compressed, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      const { data } = db.storage.from("waxlab-photos").getPublicUrl(path);
      return { id:photoId, url:data.publicUrl, storagePath:path, thumb, ts:nowStr(), caption:"", sizeKb:Math.round(compressed.size/1024) };
    } catch (e) {
      console.warn("Supabase photo upload failed, falling back to IndexedDB:", e.message);
    }
  }
  // IndexedDB fallback: store compressed blob locally, idb:// scheme as URL sentinel
  await idbPut(photoId, compressed);
  return { id:photoId, url:`idb://${photoId}`, storagePath:null, thumb, ts:nowStr(), caption:"", sizeKb:Math.round(compressed.size/1024) };
}

async function deletePhoto(photo) {
  if (photo.storagePath && supabaseConfigured) {
    try {
      await db.storage.from("waxlab-photos").remove([photo.storagePath]);
    } catch (e) {
      console.warn("Supabase photo delete failed:", e.message);
    }
  }
  if (photo.url?.startsWith("idb://")) {
    await idbDelete(photo.id).catch(() => {});
  }
}

// Resolve a photo URL to a displayable src.
// Supabase URLs are used directly; idb:// blobs are converted to object URLs.
const _blobCache = {};
async function resolvePhotoUrl(photo) {
  if (!photo?.url) return null;
  if (!photo.url.startsWith("idb://")) return photo.url;
  if (_blobCache[photo.id]) return _blobCache[photo.id];
  const blob = await idbGet(photo.id).catch(() => null);
  if (!blob) return null;
  const objUrl = URL.createObjectURL(blob);
  _blobCache[photo.id] = objUrl;
  return objUrl;
}




// ─── BACKUP / RESTORE ─────────────────────────────────────────────────────────
function BackupRestore({ teamCode, events, onRestore }) {
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  function doExport() {
    const payload = {
      version: 1,
      teamCode,
      exportedAt: new Date().toISOString(),
      events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `waxlab-backup-${teamCode}-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("✓ Backup downloaded");
    setTimeout(() => setMsg(null), 3000);
  }

  function doImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const payload = JSON.parse(ev.target.result);
        if (!Array.isArray(payload.events)) throw new Error("Invalid backup file");
        onRestore(payload.events);
        setMsg(`✓ Restored ${payload.events.length} event${payload.events.length!==1?"s":""}`);
      } catch(err) {
        setMsg(`✗ ${err.message}`);
      }
      setImporting(false);
      e.target.value = "";
      setTimeout(() => setMsg(null), 4000);
    };
    reader.readAsText(file);
  }

  return (
    <div style={{ marginTop: 24, borderTop: "1.5px solid var(--rule)", paddingTop: 20 }}>
      <Lbl>Backup & Restore</Lbl>
      <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 12, lineHeight: 1.5 }}>
        Download all {teamCode} event data as a JSON file, or restore from a previous backup.
        Restore merges — it will not delete existing events.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-ghost" onClick={doExport}
          style={{ flex: 1, fontSize: 13, padding: "10px 0" }}>
          ↓ Download Backup
        </button>
        <button className="btn-ghost"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          style={{ flex: 1, fontSize: 13, padding: "10px 0" }}>
          ↑ Restore from File
        </button>
        <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }}
          onChange={doImport} />
      </div>
      {msg && (
        <div style={{ fontSize: 13, marginTop: 8, fontWeight: 600,
          color: msg.startsWith("✓") ? "var(--green)" : "var(--red)" }}>
          {msg}
        </div>
      )}
    </div>
  );
}

// ─── SYNC STATUS DETAIL ───────────────────────────────────────────────────────
// Shows in the Home screen header — a persistent indicator with detail
// on pending/failed writes, not just the dot in the TeamBar.
function SyncStatusBanner({ syncStatus, online, pendingCount }) {
  if (!online) return (
    <div style={{ background:"var(--amber)", color:"#fff",
      padding:"8px 16px", fontSize:12, fontWeight:600,
      display:"flex", alignItems:"center", gap:8 }}>
      <span>⚠</span>
      <span>Offline — changes saved locally and will sync when reconnected</span>
    </div>
  );
  if (syncStatus === "error") return (
    <div style={{ background:"var(--red)", color:"#fff",
      padding:"8px 16px", fontSize:12, fontWeight:600,
      display:"flex", alignItems:"center", gap:8 }}>
      <span>✗</span>
      <span>Sync error — check your connection. Changes are saved locally.</span>
    </div>
  );
  if (syncStatus === "saving") return (
    <div style={{ background:"var(--paper-2)", borderBottom:"1.5px solid var(--rule)",
      padding:"6px 16px", fontSize:11, color:"var(--ink-faint)",
      display:"flex", alignItems:"center", gap:6 }}>
      <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>↻</span>
      <span>Saving…</span>
    </div>
  );
  return null;
}

// ─── PRODUCT LIBRARY ──────────────────────────────────────────────────────────
function ProductLibrary({ allEvents, useCelsius, onBack, onImportHistory }) {
  const [catFilter,  setCatFilter]  = useState("all");
  const [snowFilter, setSnowFilter] = useState("");
  const [tempBand,   setTempBand]   = useState("");
  const [sortBy,     setSortBy]     = useState("wins");

  // Build product database from all events
  const products = useMemo(() => {
    const map = {};  // key = product name → stats

    (allEvents||[]).forEach(ev => {
      (ev.sessions||[]).forEach(sess => {
        (sess.tests||[]).forEach(test => {
          const w = ev.weather || {};
          const airF  = w.airTempF;
          const snowF = (sess.snowTemps||[]).slice(-1)[0]?.tempF
                     ?? (test.snowTemps||[]).slice(-1)[0]?.tempF;
          const snowType  = w.snowType  || "";
          const category  = test.category;

          (test.skis||[]).forEach(ski => {
            if (!ski.product) return;
            const key = ski.product.trim().toLowerCase();
            if (!map[key]) map[key] = {
              product: ski.product.trim(),
              application: ski.application || "",
              wins: 0, losses: 0, appearances: 0,
              categories: new Set(),
              snowTypes: {},
              airTemps: [], snowTemps: [],
              ratings: [],
              eventNames: new Set(),
            };
            const entry = map[key];
            entry.appearances++;
            entry.categories.add(category);
            entry.eventNames.add(ev.name);
            if (airF  != null) entry.airTemps.push(airF);
            if (snowF != null) entry.snowTemps.push(snowF);
            if (snowType) entry.snowTypes[snowType] = (entry.snowTypes[snowType]||0) + 1;

            const isG = category === "glide" || category === "glide-out";
            const comp = isG ? ski.ratings?.glide
              : (ski.ratings?.kick!=null&&ski.ratings?.glide!=null
                  ? ski.ratings.kick+ski.ratings.glide : null);
            if (comp != null) entry.ratings.push(comp);

            if (ski.standing === "Winner") entry.wins++;
            else if (ski.standing === "Eliminated") entry.losses++;
          });
        });
      });
    });

    return Object.values(map).map(e => {
      const avgAir  = e.airTemps.length  ? e.airTemps.reduce((a,b)=>a+b,0)/e.airTemps.length   : null;
      const avgSnow = e.snowTemps.length ? e.snowTemps.reduce((a,b)=>a+b,0)/e.snowTemps.length : null;
      const avgRating = e.ratings.length ? e.ratings.reduce((a,b)=>a+b,0)/e.ratings.length     : null;
      const winRate = (e.wins + e.losses) > 0 ? e.wins / (e.wins + e.losses) : null;
      const topSnowType = Object.entries(e.snowTypes).sort((a,b)=>b[1]-a[1])[0]?.[0] || "";
      return {
        ...e,
        categories: [...e.categories],
        eventNames: [...e.eventNames],
        avgAir, avgSnow, avgRating, winRate, topSnowType,
      };
    });
  }, [allEvents]);

  // Temp bands helper
  const tempBandMatch = (avgF) => {
    if (!tempBand || avgF==null) return !tempBand;
    if (tempBand === "warm")   return avgF >= 28;   // ≥ -2°C
    if (tempBand === "mid")    return avgF >= 14 && avgF < 28;  // -10 to -2°C
    if (tempBand === "cold")   return avgF < 14;    // < -10°C
    return true;
  };

  const filtered = products
    .filter(p => catFilter === "all" || p.categories.includes(catFilter))
    .filter(p => !snowFilter || p.snowTypes[snowFilter] > 0)
    .filter(p => !tempBand  || tempBandMatch(p.avgAir))
    .sort((a,b) => {
      if (sortBy === "wins")    return (b.wins||0) - (a.wins||0);
      if (sortBy === "winrate") return (b.winRate??-1) - (a.winRate??-1);
      if (sortBy === "rating")  return (b.avgRating??-1) - (a.avgRating??-1);
      if (sortBy === "name")    return a.product.localeCompare(b.product);
      return 0;
    });

  const snowTypes = [...new Set(products.flatMap(p => Object.keys(p.snowTypes)))].sort();

  function dispF(f) { if (f==null) return "—"; return useCelsius ? `${((f-32)*5/9).toFixed(1)}°C` : `${Math.round(f)}°F`; }

  return (
    <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
      <div className="view-header">
        <BackBtn onClick={onBack} />
        <div style={{ fontSize:15, fontWeight:700 }}>Product Library</div>
        <button className="btn-ghost" onClick={onImportHistory}
          style={{ fontSize:11, padding:"6px 10px", minHeight:32 }}>
          Import History
        </button>
      </div>
      <div style={{ padding:16 }}>

        {/* Filters */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
          <div>
            <Lbl>Category</Lbl>
            <select className="inp" value={catFilter} onChange={e=>setCatFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="glide">Glide</option>
              <option value="kick">Kick</option>
            </select>
          </div>
          <div>
            <Lbl>Sort by</Lbl>
            <select className="inp" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
              <option value="wins">Most wins</option>
              <option value="winrate">Win rate</option>
              <option value="rating">Avg rating</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
          <div>
            <Lbl>Snow type</Lbl>
            <select className="inp" value={snowFilter} onChange={e=>setSnowFilter(e.target.value)}>
              <option value="">Any</option>
              {snowTypes.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <Lbl>Air temp range</Lbl>
            <select className="inp" value={tempBand} onChange={e=>setTempBand(e.target.value)}>
              <option value="">Any</option>
              <option value="warm">Warm (≥ {useCelsius?"-2°C":"28°F"})</option>
              <option value="mid">Mid ({useCelsius?"-10 to -2°C":"14–28°F"})</option>
              <option value="cold">Cold (&lt; {useCelsius?"-10°C":"14°F"})</option>
            </select>
          </div>
        </div>

        {products.length === 0 && (
          <div style={{ color:"var(--ink-faint)", textAlign:"center", padding:"40px 0", fontSize:14 }}>
            No product data yet. Winners from tests will appear here.
          </div>
        )}
        {filtered.length === 0 && products.length > 0 && (
          <div style={{ color:"var(--ink-faint)", textAlign:"center", padding:"32px 0", fontSize:14 }}>
            No products match these filters.
          </div>
        )}

        {filtered.map((p, i) => (
          <div key={p.product} className="card" style={{ marginBottom:8, padding:"12px 14px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start",
              marginBottom: p.application ? 2 : 6 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <span style={{ fontWeight:700, fontSize:15 }}>{p.product}</span>
                {p.application && (
                  <div style={{ fontSize:12, color:"var(--ink-mid)", marginTop:1 }}>{p.application}</div>
                )}
                <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:3 }}>
                  {[...new Set(p.categories)].join(" · ")}
                  {p.topSnowType ? ` · ${p.topSnowType}` : ""}
                </div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0, marginLeft:12 }}>
                <span style={{ fontWeight:800, fontSize:18,
                  color: p.wins > 0 ? "var(--green)" : "var(--ink-faint)" }}>
                  {p.wins}W
                </span>
                {p.losses > 0 && (
                  <span style={{ fontSize:14, color:"var(--ink-faint)", marginLeft:4 }}>
                    {p.losses}L
                  </span>
                )}
                {p.winRate != null && (
                  <div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:1 }}>
                    {(p.winRate*100).toFixed(0)}% win
                  </div>
                )}
              </div>
            </div>

            <div style={{ display:"flex", gap:16, flexWrap:"wrap", marginTop:4 }}>
              {p.avgAir != null && (
                <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
                  air {dispF(p.avgAir)} avg
                </span>
              )}
              {p.avgSnow != null && (
                <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
                  snow {dispF(p.avgSnow)} avg
                </span>
              )}
              {p.avgRating != null && (
                <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
                  ★ {p.avgRating.toFixed(1)} avg
                </span>
              )}
              <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
                {p.appearances} tests · {p.eventNames.length} event{p.eventNames.length!==1?"s":""}
              </span>
            </div>

            {/* Snow type breakdown if multiple */}
            {Object.keys(p.snowTypes).length > 1 && (
              <div style={{ marginTop:6, display:"flex", gap:6, flexWrap:"wrap" }}>
                {Object.entries(p.snowTypes)
                  .sort((a,b)=>b[1]-a[1])
                  .map(([type, count]) => (
                    <span key={type} className="tag mono"
                      style={{ fontSize:9, padding:"2px 6px" }}>
                      {type} ×{count}
                    </span>
                  ))
                }
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HISTORICAL DATA IMPORT ───────────────────────────────────────────────────
// Accepts any tabular or structured format and maps it to WaxLab winner records.
// Supported: CSV, JSON, TSV, Excel-style pasted text, or free-form key:value blocks.
// The parser is intentionally liberal — it tries multiple strategies and keeps
// anything that looks like a wax product + conditions + outcome triple.

function parseHistoricalData(raw) {
  const text = raw.trim();
  const results = [];
  const errors  = [];

  // ── Strategy 1: JSON ──────────────────────────────────────────────────────
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      rows.forEach((row, i) => {
        const r = extractFromObject(row);
        if (r) results.push(r);
        else errors.push(`Row ${i+1}: could not find product name`);
      });
      return { results, errors, format: "JSON" };
    } catch(e) {
      errors.push("JSON parse error: " + e.message);
    }
  }

  // ── Strategy 2: CSV / TSV ────────────────────────────────────────────────
  const delimiter = text.includes("\t") ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length >= 2) {
    const headers = parseCSVRow(lines[0], delimiter).map(h => h.trim().toLowerCase());
    const hasHeader = headers.some(h =>
      /product|wax|brand|name|glide|kick|winner|result|condition|temp|snow|air|date|event/i.test(h)
    );
    if (hasHeader) {
      lines.slice(1).forEach((line, i) => {
        if (!line.trim()) return;
        const vals = parseCSVRow(line, delimiter);
        const obj = {};
        headers.forEach((h, j) => { obj[h] = (vals[j]||"").trim(); });
        const r = extractFromObject(obj);
        if (r) results.push(r);
        else errors.push(`Row ${i+2}: could not extract product`);
      });
      if (results.length > 0)
        return { results, errors, format: delimiter==="\t"?"TSV":"CSV" };
    }
  }

  // ── Strategy 3: key:value blocks (blank-line separated) ──────────────────
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  if (blocks.length > 0 && blocks[0].includes(":")) {
    blocks.forEach((block, i) => {
      const obj = {};
      block.split(/\r?\n/).forEach(line => {
        const sep = line.indexOf(":");
        if (sep > 0) {
          const k = line.slice(0, sep).trim().toLowerCase();
          const v = line.slice(sep+1).trim();
          obj[k] = v;
        }
      });
      const r = extractFromObject(obj);
      if (r) results.push(r);
      else errors.push(`Block ${i+1}: could not extract product`);
    });
    if (results.length > 0)
      return { results, errors, format: "Key:Value" };
  }

  // ── Strategy 4: free-form lines — heuristic scan ─────────────────────────
  // Each line might be: "ProductName, airTemp, snowType, outcome"
  lines.forEach((line, i) => {
    const r = extractFromFreeText(line);
    if (r) results.push(r);
  });
  if (results.length > 0)
    return { results, errors, format: "Free text" };

  return { results: [], errors: ["Could not parse — try CSV with headers, JSON, or key:value format"], format: "Unknown" };
}

// Parse one CSV row respecting quoted fields
function parseCSVRow(line, delimiter) {
  const result = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === delimiter && !inQ) { result.push(cur); cur = ""; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

// Column name synonyms for fuzzy matching
const COL_MAP = {
  product:     ["product","wax","brand","glide_wax","kick_wax","wax_brand","product_name","name","ski_wax","topcoat","binder","material"],
  application: ["application","app","method","technique","structure","applied_as","how_applied","application_method"],
  category:    ["category","cat","type","test_type","wax_type","kind"],
  airTemp:     ["air_temp","air","air_temperature","temp_air","ambient","temp","temperature","outside_temp","air_f","air_c","outside"],
  snowTemp:    ["snow_temp","snow","snow_temperature","temp_snow","surface_temp","snow_f","snow_c","snow_surface"],
  snowType:    ["snow_type","snow_condition","conditions","condition","snow","surface","grooming","type","snow_kind"],
  outcome:     ["outcome","result","winner","won","placed","rank","ranking","finish","status","standing","win","1st","first"],
  rating:      ["rating","score","rate","stars","grade","quality","performance","glide_score","kick_score","feedback"],
  event:       ["event","race","competition","meet","date_location","venue","location_event"],
  date:        ["date","day","race_date","event_date","when"],
  location:    ["location","venue","where","place","course","trail","site"],
  notes:       ["notes","note","comment","comments","observation","observations","remarks"],
};

function findCol(obj, field) {
  const synonyms = COL_MAP[field] || [field];
  for (const key of Object.keys(obj)) {
    const k = key.toLowerCase().replace(/[\s\-\.]/g, "_");
    if (synonyms.some(s => k === s || k.includes(s) || s.includes(k))) {
      return obj[key];
    }
  }
  return null;
}

// Parse a temperature string that might be "23F", "23°F", "-5C", "-5°C", "23", etc.
function parseTempToF(str) {
  if (!str && str !== 0) return null;
  const s = String(str).trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  // Detect unit
  if (/c$/i.test(s) || s.includes("°c") || s.includes("celsius")) {
    return Math.round((num * 9/5 + 32) * 10) / 10;
  }
  // If value is below -20, it's probably Celsius even without label
  if (num < -20) return Math.round((num * 9/5 + 32) * 10) / 10;
  return num;
}

// Determine if an outcome string means "winner"
function isWinner(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  if (/^(winner|won|1st|first|1|yes|true|selected|chose|best|top|chose|selected|chose|win)$/.test(s)) return true;
  if (/^(lost|2nd|3rd|no|false|eliminated|reject|skip|drop|second|third)$/.test(s)) return false;
  return null;
}

function extractFromObject(obj) {
  const product = findCol(obj, "product") || findCol(obj, "notes");
  if (!product || !product.trim()) return null;
  const airF  = parseTempToF(findCol(obj, "airTemp"));
  const snowF = parseTempToF(findCol(obj, "snowTemp"));
  const snowType   = findCol(obj, "snowType") || "";
  const application= findCol(obj, "application") || "";
  const categoryRaw= findCol(obj, "category") || "";
  const category   = /kick/i.test(categoryRaw) ? "kick" : "glide";
  const outcome    = isWinner(findCol(obj, "outcome"));
  const ratingRaw  = findCol(obj, "rating");
  const rating     = ratingRaw!=null ? parseFloat(ratingRaw) : null;
  const eventName  = findCol(obj, "event") || findCol(obj, "location") || "Historical";
  const date       = findCol(obj, "date") || "";
  const notes      = findCol(obj, "notes") || "";
  return { product: product.trim(), application: application.trim(), category,
    airF, snowF, snowType: snowType.trim(), winner: outcome, rating,
    eventName: eventName.trim(), date: date.trim(), notes: notes.trim() };
}

// Heuristic free-text extraction: "Swix V45 / -5C / Dry packed / Winner"
function extractFromFreeText(line) {
  const parts = line.split(/[,\/|;]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const product = parts[0];
  if (!product || product.length < 2) return null;
  let airF = null, snowF = null, snowType = "", winner = null;
  parts.slice(1).forEach(p => {
    const t = parseTempToF(p);
    if (t !== null) { if (airF===null) airF=t; else snowF=t; }
    if (/winner|won|1st|best/i.test(p)) winner = true;
    if (/eliminat|lost|no|2nd|3rd/i.test(p)) winner = false;
    if (/powder|packed|wet|granular|variable|transform/i.test(p)) snowType = p;
  });
  return { product, application:"", category:"glide", airF, snowF,
    snowType, winner, rating:null, eventName:"Historical", date:"", notes:line };
}

// Convert parsed records into WaxLab event structures for the prediction model
function buildHistoricalEvents(records) {
  // Group by eventName so related records share an event context
  const byEvent = {};
  records.forEach(r => {
    const key = r.eventName || "Historical";
    if (!byEvent[key]) byEvent[key] = [];
    byEvent[key].push(r);
  });

  return Object.entries(byEvent).map(([evName, recs]) => {
    // Use first record's date and conditions as event-level weather
    const first = recs[0];
    const sessions = [{
      id: uid(),
      name: "Imported",
      weather: {
        airTempF: first.airF,
        snowType: first.snowType || undefined,
      },
      snowTemps: first.snowF != null ? [{ ts: new Date().toISOString(), tempF: first.snowF }] : [],
      tests: recs.map(r => {
        const skiId = "H1";
        const standing = r.winner === true ? "Winner" : r.winner === false ? "Eliminated" : "Active";
        const ratings  = r.rating != null
          ? (r.category === "glide" || r.category === "glide-out" ? { glide: Math.min(10, r.rating) } : { kick: Math.min(10, r.rating), glide: null })
          : {};
        return {
          id: uid(),
          name: r.product,
          category: r.category,
          type: "Historical",
          testers: "",
          skis: [{
            id: skiId, product: r.product, application: r.application,
            notes: r.notes, standing, ratings, feelNotes: "",
          }],
          snowTemps: r.snowF != null ? [{ ts: new Date().toISOString(), tempF: r.snowF }] : [],
          airTemps:  [],
          glideOutRuns: [],
          notes: r.notes,
          createdAt: new Date().toISOString(),
        };
      }),
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    }];

    return {
      id: uid(),
      name: evName,
      raceName: "",
      location: "",
      date: first.date || new Date().toISOString().slice(0,10),
      sessions,
      weather: { airTempF: first.airF, snowType: first.snowType },
      notes: "Imported historical data",
      createdAt: new Date().toISOString(),
      _historical: true,
    };
  });
}

// ─── HISTORICAL IMPORT VIEW ───────────────────────────────────────────────────
const IMPORT_EXAMPLE = `# Paste any format — CSV with headers, JSON, TSV, key:value blocks, or comma-separated lines.

# CSV example:
Product,Application,Category,Air Temp,Snow Temp,Snow Type,Outcome,Rating,Event
Swix LF10,2 layers,glide,-5C,-8C,Dry packed,Winner,8.5,Craftsbury Dec
Toko HF Red,thin,glide,-5C,-8C,Dry packed,Eliminated,6.0,Craftsbury Dec

# JSON example:
[{"product":"Rex Blue","airTemp":"-10C","snowType":"Dry powder","outcome":"Winner","event":"Rumford Jan"}]

# Key:value blocks (blank line between records):
Product: Vauhti LF
Air Temp: 28F
Snow Type: Wet packed
Outcome: Winner
Event: Stowe March

Product: Swix V45
Category: kick
Air Temp: 28F
Outcome: Eliminated`;

function HistoricalImport({ onImport, onBack }) {
  const [text,      setText]     = useState("");
  const [preview,   setPreview]  = useState(null);
  const [step,      setStep]     = useState("input"); // "input" | "preview" | "done"
  const [importing, setImporting]= useState(false);
  const fileRef = useRef(null);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setText(ev.target.result); e.target.value = ""; };
    reader.readAsText(file);
  }

  function handleParse() {
    const { results, errors, format } = parseHistoricalData(text);
    setPreview({ results, errors, format });
    setStep("preview");
  }

  function handleImport() {
    setImporting(true);
    const events = buildHistoricalEvents(preview.results);
    onImport(events);
    setStep("done");
    setImporting(false);
  }

  // Column display helpers
  function dispTempF(f) { return f != null ? `${Math.round(f)}°F` : "—"; }

  return (
    <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
      <div className="view-header">
        <BackBtn onClick={onBack} />
        <div style={{ fontSize:15, fontWeight:700 }}>Import Historical Data</div>
        <div />
      </div>

      <div style={{ padding:16 }}>

        {step === "input" && (<>
          <div style={{ fontSize:13, color:"var(--ink-mid)", marginBottom:16, lineHeight:1.6 }}>
            Paste wax records in any format — CSV, JSON, TSV, key:value blocks, or
            comma-separated lines. The importer maps whatever columns it finds to the
            prediction model. Accepted column names are flexible (e.g. "wax", "product",
            "brand" all map to product name).
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <button className="btn-ghost" onClick={()=>fileRef.current?.click()}
              style={{ flex:1, fontSize:13, padding:"10px 0" }}>
              Load from file
            </button>
            <button className="btn-ghost" onClick={()=>setText(IMPORT_EXAMPLE)}
              style={{ flex:1, fontSize:13, padding:"10px 0" }}>
              Show example
            </button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.json,.txt"
              style={{ display:"none" }} onChange={handleFile} />
          </div>

          <textarea className="inp" value={text} onChange={e=>setText(e.target.value)}
            placeholder={"Paste CSV, JSON, or any structured text here…"}
            style={{ minHeight:240, fontFamily:"'SF Mono','Courier New',monospace",
              fontSize:12, lineHeight:1.6 }} />

          <div style={{ display:"flex", gap:8, marginTop:12 }}>
            <button className="btn" onClick={handleParse} disabled={!text.trim()}
              style={{ flex:1, fontSize:13 }}>
              Parse Data
            </button>
            <button className="btn-ghost" onClick={onBack}
              style={{ fontSize:13, padding:"0 20px" }}>
              Cancel
            </button>
          </div>
        </>)}

        {step === "preview" && preview && (<>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <Lbl style={{ marginBottom:0 }}>
              {preview.results.length} record{preview.results.length!==1?"s":""} parsed
              {" · "}{preview.format}
            </Lbl>
            <button className="btn-ghost" onClick={()=>setStep("input")}
              style={{ fontSize:12, padding:"6px 12px", minHeight:34 }}>
              Edit
            </button>
          </div>

          {preview.errors.length > 0 && (
            <div style={{ background:"var(--paper-2)", border:"1.5px solid var(--rule)",
              borderRadius:6, padding:12, marginBottom:12 }}>
              <div style={{ fontSize:12, fontWeight:700, color:"var(--amber)", marginBottom:6 }}>
                {preview.errors.length} row{preview.errors.length!==1?"s":""} skipped
              </div>
              {preview.errors.slice(0,5).map((e,i)=>(
                <div key={i} style={{ fontSize:11, color:"var(--ink-faint)", fontFamily:"monospace" }}>{e}</div>
              ))}
              {preview.errors.length > 5 && (
                <div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:4 }}>
                  …and {preview.errors.length-5} more
                </div>
              )}
            </div>
          )}

          {preview.results.length === 0 ? (
            <div style={{ color:"var(--ink-faint)", textAlign:"center", padding:"32px 0", fontSize:14 }}>
              No records could be extracted. Check the format and try again.
            </div>
          ) : (<>
            {/* Preview table */}
            <div style={{ overflowX:"auto", marginBottom:12 }}>
              <table className="cmp-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Cat</th>
                    <th>Air</th>
                    <th>Snow Type</th>
                    <th>Outcome</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.results.slice(0,20).map((r,i)=>(
                    <tr key={i}>
                      <td style={{ fontWeight:600, fontSize:12 }}>{r.product}</td>
                      <td style={{ fontSize:11 }}>{r.category}</td>
                      <td style={{ fontSize:11 }}>{dispTemp(r.airF)}</td>
                      <td style={{ fontSize:11 }}>{r.snowType||"—"}</td>
                      <td style={{ fontSize:11,
                        color: r.winner===true?"var(--green)":r.winner===false?"var(--red)":"var(--ink-faint)" }}>
                        {r.winner===true?"Winner":r.winner===false?"Eliminated":"Unknown"}
                      </td>
                      <td style={{ fontSize:11 }}>{r.eventName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.results.length > 20 && (
                <div style={{ fontSize:11, color:"var(--ink-faint)", padding:"6px 0", textAlign:"right" }}>
                  …and {preview.results.length-20} more rows
                </div>
              )}
            </div>

            <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:12, lineHeight:1.5 }}>
              Records will be imported as historical events visible only to the prediction model.
              They will not appear in your main event list. Winners without temperatures
              still improve prediction accuracy for snow type matching.
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button className="btn" onClick={handleImport} disabled={importing}
                style={{ flex:1, fontSize:13 }}>
                {importing ? "Importing…" : `Import ${preview.results.length} Records`}
              </button>
              <button className="btn-ghost" onClick={()=>setStep("input")}
                style={{ fontSize:13, padding:"0 20px" }}>
                Back
              </button>
            </div>
          </>)}
        </>)}

        {step === "done" && (
          <div style={{ textAlign:"center", padding:"48px 16px" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>✓</div>
            <div style={{ fontSize:18, fontWeight:700, marginBottom:8 }}>
              {preview?.results.length} records imported
            </div>
            <div style={{ fontSize:14, color:"var(--ink-mid)", marginBottom:24, lineHeight:1.6 }}>
              These records are now available to the prediction model across all teams.
              Open the Conditions tab in any session to see suggestions.
            </div>
            <button className="btn" onClick={onBack} style={{ fontSize:14, padding:"14px 32px" }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── COPY HELPERS ─────────────────────────────────────────────────────────────
// Duplicate a test preserving fleet setup but clearing all results/ratings.
function copyTest(test, nameSuffix=" (copy)") {
  return {
    id: uid(),
    name: (test.name||"") + nameSuffix,
    category: test.category,
    type: test.type||"",
    testers: test.testers||"",
    skis: (test.skis||[]).map(ski => ({
      id:          ski.id,
      product:     ski.product||"",
      application: ski.application||"",
      notes:       ski.notes||"",
      standing:    "Active",   // reset tournament state
      ratings:     {},
      feelNotes:   "",
    })),
    snowTemps:    [],
    airTemps:     [],
    glideOutRuns: [],
    notes:        "",
    deadline:     null,
    createdAt:    nowStr(),
  };
}

// Duplicate a session preserving name, weather, and fleet setup of each test.
function copySession(session, allSessions) {
  const baseName = session.name.replace(/ \(copy( \d+)?\)$/, "");
  // Find how many copies already exist to avoid "copy (copy (copy))"
  const existingCopies = (allSessions||[]).filter(s =>
    s.name === baseName+" (copy)" || /^.*\(copy \d+\)$/.test(s.name)
  ).length;
  const suffix = existingCopies === 0 ? " (copy)" : ` (copy ${existingCopies+1})`;
  return {
    id:         uid(),
    name:       baseName + suffix,
    weather:    { ...(session.weather||{}) },   // keep conditions
    tests:      (session.tests||[]).map(t => copyTest(t, "")),
    snowTemps:  [],
    createdAt:  nowStr(),
    startedAt:  nowStr(),
  };
}

// ─── FLEET REGISTRY ───────────────────────────────────────────────────────────
// Team-level persistent ski fleet definitions.
// Stored in Supabase table waxlab_fleets (team_code, data jsonb) or localStorage.
// Each fleet object: { id, name, category:"glide"|"kick",
//                      skis:[{ id, make, flex, grind, notes }] }

async function loadFleets(teamCode) {
  if (db) {
    try {
      const { data, error } = await db
        .from("waxlab_fleets")
        .select("data")
        .eq("team_code", teamCode)
        .single();
      if (!error && data?.data) return data.data;
    } catch(e) { /* fall through to localStorage */ }
  }
  return lsGet(`waxlab:fleets:${teamCode}`) || [];
}

async function saveFleets(teamCode, fleets) {
  lsSet(`waxlab:fleets:${teamCode}`, fleets);   // always save locally too
  if (db) {
    try {
      await db.from("waxlab_fleets").upsert(
        { team_code: teamCode, data: fleets },
        { onConflict: "team_code" }
      );
    } catch(e) { /* silently continue with local copy */ }
  }
}

// ─── WEATHER ──────────────────────────────────────────────────────────────────
// Geocode a place name with two-stage fallback:
// Stage 1: Open-Meteo (best for clean city names, also handles zip codes)
//   - Strips "City, ST" → "City" before querying (Open-Meteo fails on abbreviations)
// Stage 2: Nominatim (handles "City, State", "City ST", full addresses, zip codes)
// Returns array of { lat, lon, label } sorted by confidence; throws if nothing found.
async function geocodePlaceMulti(name) {
  const results = [];

  // ── Stage 1: Open-Meteo ───────────────────────────────────────────────────
  // Pre-process: extract just the city portion before any comma or state abbrev
  const clean = name.trim()
    .replace(/,\s*[A-Z]{2}\s*$/i, "")   // strip trailing ", VT" or ", CA"
    .replace(/\s+[A-Z]{2}\s*$/,   "")   // strip trailing " VT" (no comma)
    .replace(/,\s*\w+\s*$/,        "")   // strip trailing ", Vermont"
    .trim();

  const omQueries = [...new Set([name.trim(), clean])].filter(Boolean);
  for (const q of omQueries) {
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=3&language=en`
      );
      if (!r.ok) continue;
      const d = await r.json();
      for (const item of (d.results || [])) {
        const label = [item.name, item.admin1, item.country].filter(Boolean).join(", ");
        results.push({ lat: item.latitude, lon: item.longitude, label, source: "om" });
      }
      if (results.length >= 1) break; // found something — skip second OM query
    } catch { /* network error — try next */ }
  }

  // ── Stage 2: Nominatim (handles "City, State", zip, full address) ──────────
  if (results.length === 0) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name.trim())}&format=json&limit=3&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      );
      if (r.ok) {
        const d = await r.json();
        for (const item of d) {
          const a = item.address || {};
          const city = a.city || a.town || a.village || a.municipality || a.county || "";
          const state = a.state || a.province || "";
          const country = a.country_code?.toUpperCase() || "";
          const label = [city, state, country].filter(Boolean).join(", ") || item.display_name.split(",").slice(0,2).join(",").trim();
          results.push({ lat: parseFloat(item.lat), lon: parseFloat(item.lon), label, source: "nom" });
        }
      }
    } catch { /* silently skip */ }
  }

  if (results.length === 0) throw new Error("Place not found — try a city name or zip code");
  return results;
}

// Convenience wrapper — returns the best single result
async function geocodePlace(name) {
  const results = await geocodePlaceMulti(name);
  return results[0];
}
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,snow_depth`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Weather API ${r.status}`);
  const d = await r.json();
  if (!d.current) throw new Error("No data in response");
  const c = d.current;
  const skyMap = {0:"Clear",1:"Mostly Clear",2:"Partly Cloudy",3:"Overcast",45:"Foggy",48:"Foggy",
    51:"Light Drizzle",53:"Drizzle",55:"Heavy Drizzle",61:"Light Rain",63:"Rain",65:"Heavy Rain",
    71:"Light Snow",73:"Snow",75:"Heavy Snow",77:"Snow Grains",80:"Rain Showers",81:"Rain Showers",
    82:"Heavy Rain Showers",85:"Snow Showers",86:"Heavy Snow Showers",95:"Thunderstorm",96:"Thunderstorm",99:"Thunderstorm"};
  const wCode = c.weather_code ?? c.weathercode ?? null;
  return {
    airTempF:   c.temperature_2m   != null ? Math.round(c.temperature_2m)   : null,
    humidity:   c.relative_humidity_2m ?? null,
    windMph:    c.wind_speed_10m   != null ? Math.round(c.wind_speed_10m)    : null,
    sky:        wCode != null ? (skyMap[wCode] || "Unknown") : null,
    snowDepthCm:c.snow_depth       != null ? Math.round(c.snow_depth * 100)  : null,
    weatherFetchedAt: new Date().toISOString(),
  };
}
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    if (!r.ok) return null;
    const d = await r.json();
    const a = d.address || {};
    const parts = [a.resort||a.leisure||a.tourism, a.village||a.town||a.city||a.municipality, a.state||a.county].filter(Boolean);
    return parts.length ? parts.join(", ") : d.display_name?.split(",").slice(0,2).join(",").trim()||null;
  } catch { return null; }
}

// ─── UNIT HELPERS ─────────────────────────────────────────────────────────────
function fToC(f) { return f == null ? null : Math.round((f - 32) * 5 / 9 * 10) / 10; }
function cToF(c) { return c == null ? null : Math.round(c * 9 / 5 + 32); }
function dispTemp(f, useCelsius) {
  if (f == null) return null;
  return useCelsius ? `${fToC(f)}°C` : `${f}°F`;
}
function storeTemp(val, useCelsius) {
  // Always store in F internally
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  return useCelsius ? cToF(n) : n;
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function uid()        { return Math.random().toString(36).slice(2,10); }
function nowStr()     { return new Date().toISOString(); }
function fmtDate(iso) { if (!iso) return ""; return new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
function fmtTime(iso) { if (!iso) return ""; return new Date(iso).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}); }
function fmtDateTime(iso) { if (!iso) return ""; return new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}); }
function fmtDuration(startIso) {
  if (!startIso) return "";
  const ms = Date.now() - new Date(startIso).getTime();
  const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
  return `${m}:${s.toString().padStart(2,"0")}`;
}
function nextSkiId(skis) {
  // Suggest IDs in A1, A2, A3… B1, B2… format
  // Find the current highest letter group and next number within it
  const existing = (skis||[]).map(s=>(s.id||"").toUpperCase());
  // Parse IDs that match the letter+number pattern
  const parsed = existing.map(id=>{ const m=id.match(/^([A-Z]+)(\d+)$/); return m?{letter:m[1],num:parseInt(m[2])}:null; }).filter(Boolean);
  if (!parsed.length) return "A1";
  // Find the letter group with the most recent entries (highest letter)
  const letters = [...new Set(parsed.map(p=>p.letter))].sort();
  const curLetter = letters[letters.length-1];
  const numsInGroup = parsed.filter(p=>p.letter===curLetter).map(p=>p.num);
  const nextNum = Math.max(...numsInGroup)+1;
  // After 4 in a group, suggest moving to next letter
  if (nextNum > 4) {
    const nextLetter = String.fromCharCode(curLetter.charCodeAt(0)+1);
    return `${nextLetter}1`;
  }
  return `${curLetter}${nextNum}`;
}

function suggestedSkiIds(skis) {
  // Always show exactly 6 quick-tap suggestions in A1, A2, B1, B2, C1, C2... pattern
  // Two slots per letter group, advancing through the alphabet
  const existing = new Set((skis||[]).map(s=>(s.id||"").toUpperCase()));
  const suggestions = [];
  for (let i = 0; i < 26 && suggestions.length < 6; i++) {
    const letter = String.fromCharCode(65 + i); // A, B, C...
    const id1 = `${letter}1`;
    const id2 = `${letter}2`;
    if (!existing.has(id1)) suggestions.push(id1);
    if (!existing.has(id2)) suggestions.push(id2);
  }
  return suggestions;
}

// ─── THEMES ───────────────────────────────────────────────────────────────────
const LIGHT_THEME = {
  "--ink":       "#0d0b09",
  "--ink-mid":   "#3d3530",
  "--ink-faint": "#7a6e65",
  "--paper":     "#f0ebe0",
  "--paper-2":   "#e4ddd0",
  "--paper-3":   "#d8d0c4",
  "--rule":      "#a89e92",
  "--red":       "#7a1a08",
  "--green":     "#1a4a2e",
  "--amber":     "#6b3d08",
  "--blue":      "#0f2d4a",
};
const DARK_THEME = {
  "--ink":       "#f5f0e8",
  "--ink-mid":   "#c8bfb0",
  "--ink-faint": "#8a7e72",
  "--paper":     "#141210",
  "--paper-2":   "#1e1c18",
  "--paper-3":   "#2a2720",
  "--rule":      "#4a4540",
  "--red":       "#e06050",
  "--green":     "#60c080",
  "--amber":     "#d4a040",
  "--blue":      "#70a8d8",
};
function applyTheme(dark) {
  Object.entries(dark ? DARK_THEME : LIGHT_THEME).forEach(([k,v]) => document.documentElement.style.setProperty(k,v));
}

// ─── GLOBAL CSS ───────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  body { background: var(--paper); color: var(--ink); min-height: 100vh; }
  .mono { font-family: 'SF Mono', 'Fira Code', 'Courier New', monospace; }

  input, textarea, select, button { font-family: inherit; }
  input[type=range] { width: 100%; accent-color: var(--ink); height: 4px; }

  /* ── Inputs ── */
  .inp { width: 100%; background: var(--paper-2); border: 1.5px solid var(--rule);
    padding: 11px 12px; font-size: 15px; color: var(--ink); border-radius: 6px;
    transition: border-color 0.15s; -webkit-appearance: none; }
  .inp:focus { outline: none; border-color: var(--ink); }
  textarea.inp { resize: vertical; min-height: 72px; }
  select.inp { cursor: pointer; }

  /* ── Buttons ── */
  .btn { background: var(--ink); color: var(--paper); border: none;
    padding: 13px 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; cursor: pointer; border-radius: 6px;
    transition: opacity 0.12s; min-height: 44px; }
  .btn:active { opacity: 0.75; }
  .btn-ghost { background: var(--paper-2); color: var(--ink); border: 1.5px solid var(--rule);
    padding: 11px 16px; font-size: 13px; font-weight: 500; cursor: pointer; border-radius: 6px;
    transition: background 0.12s; min-height: 44px; }
  .btn-ghost:active { background: var(--paper-3); }
  .btn-text { background: none; border: none; color: var(--ink-mid); cursor: pointer;
    font-size: 13px; padding: 8px 4px; }
  .btn-text:active { color: var(--ink); }

  /* ── Tournament ── */
  .btn-advance { background: var(--green); color: #fff; border: none;
    padding: 20px 0; font-size: 15px; font-weight: 700; letter-spacing: 0.04em;
    cursor: pointer; width: 100%; transition: opacity 0.12s; }
  .btn-eliminate { background: var(--red); color: #fff; border: none;
    padding: 20px 0; font-size: 15px; font-weight: 700; letter-spacing: 0.04em;
    cursor: pointer; width: 100%; transition: opacity 0.12s; }
  .btn-advance:active, .btn-eliminate:active { opacity: 0.8; }

  /* ── Cards ── */
  .card { background: var(--paper-2); border: 1.5px solid var(--rule);
    border-radius: 8px; overflow: hidden; }
  .card + .card { margin-top: 8px; }

  /* ── Tags ── */
  .tag { display: inline-flex; align-items: center; font-family: 'SF Mono','Courier New',monospace;
    font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 4px; border: 1.5px solid currentColor; }

  /* ── Tab bar ── */
  .tab-bar { display: flex; border-bottom: 1.5px solid var(--rule); background: var(--paper);
    overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-btn { flex-shrink: 0; background: none; border: none; padding: 12px 16px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    cursor: pointer; color: var(--ink-faint); border-bottom: 2.5px solid transparent;
    margin-bottom: -1.5px; white-space: nowrap; transition: color 0.15s; }
  .tab-btn.active { color: var(--ink); border-bottom-color: var(--ink); }

  /* ── Labels ── */
  .lbl { font-family: 'SF Mono','Fira Code','Courier New',monospace; font-size: 11px;
    font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-faint); margin-bottom: 6px; display: block; }

  /* ── Autocomplete ── */
  .ac-wrap { position: relative; }
  .ac-list { position: absolute; top: calc(100% + 2px); left: 0; right: 0;
    background: var(--paper); border: 1.5px solid var(--rule); border-radius: 6px;
    z-index: 200; max-height: 180px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
  .ac-item { padding: 11px 12px; font-size: 14px; cursor: pointer; }
  .ac-item:hover, .ac-item:active { background: var(--paper-2); }

  /* ── Swipe ── */
  .swipe-card { touch-action: pan-y; user-select: none;
    transition: transform 0.15s ease, opacity 0.15s ease; }
  .swipe-card.swiping { transition: none; }

  /* ── Offline banner ── */
  .offline-bar { background: var(--amber); color: #fff; text-align: center;
    padding: 8px 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Undo toast ── */
  .undo-toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: var(--paper); padding: 12px 20px; border-radius: 10px;
    font-size: 13px; display: flex; gap: 16px; align-items: center; z-index: 999;
    box-shadow: 0 4px 24px rgba(0,0,0,0.3); white-space: nowrap; }

  /* ── Section divider ── */
  .divider { border: none; border-top: 1.5px solid var(--rule); margin: 16px 0; }

  /* ── Unit toggle pill ── */
  .unit-pill { display: inline-flex; background: var(--paper-3); border-radius: 20px;
    padding: 2px; gap: 2px; }
  .unit-pill button { background: none; border: none; padding: 4px 10px; border-radius: 16px;
    font-size: 12px; font-weight: 600; cursor: pointer; color: var(--ink-faint);
    transition: all 0.15s; }
  .unit-pill button.active { background: var(--paper); color: var(--ink);
    box-shadow: 0 1px 4px rgba(0,0,0,0.12); }

  /* ── Header ── */
  .view-header { border-bottom: 1.5px solid var(--rule); padding: 10px 16px;
    display: flex; justify-content: space-between; align-items: center;
    background: var(--paper); position: sticky; top: 0; z-index: 100; }

  /* ── Team bar ── */
  .team-bar { background: var(--paper-2); border-bottom: 1.5px solid var(--rule);
    padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; }

  /* ── Floating snow temp button ── */
  .snow-fab { position: fixed; bottom: 20px; right: 16px; z-index: 50;
    background: var(--blue); color: #fff; border: none; border-radius: 24px;
    padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2); display: flex; align-items: center; gap: 6px; }
  .air-fab  { position: fixed; bottom: 68px; right: 16px; z-index: 50;
    background: var(--amber,#e07c00); color: #fff; border: none; border-radius: 24px;
    padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2); display: flex; align-items: center; gap: 6px; }

  /* ── Snow temp modal ── */
  .snow-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 200;
    display: flex; align-items: flex-end; justify-content: center; }
  .snow-modal { background: var(--paper); border-radius: 16px 16px 0 0;
    padding: 20px 20px 36px; width: 100%; max-width: 480px; }

  /* ── Print ── */
  @media print {
    .no-print { display: none !important; }
    .print-only { display: block !important; }
    body { background: white; color: black; }
  }
  .print-only { display: none; }

  /* ── Compare table ── */
  .cmp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cmp-table th { font-family: 'SF Mono','Courier New',monospace; font-size: 10px;
    font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px;
    border-bottom: 1.5px solid var(--rule); text-align: left; color: var(--ink-faint); }
  .cmp-table td { padding: 9px 8px; border-bottom: 1px solid var(--rule); }
  .cmp-table tr:hover td { background: var(--paper-2); }

  /* ── Trend bars ── */
  .trend-wrap { display: flex; align-items: flex-end; gap: 3px; height: 56px; }
  .trend-bar { flex: 1; border-radius: 2px 2px 0 0; min-width: 16px; position: relative;
    cursor: pointer; }
  .trend-bar[data-tip]:hover::after { content: attr(data-tip);
    position: absolute; bottom: 105%; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: var(--paper); padding: 4px 8px; border-radius: 4px;
    font-size: 11px; white-space: nowrap; font-family: 'SF Mono','Courier New',monospace; }
`;

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
function Lbl({ children, style }) {
  return <span className="lbl" style={style}>{children}</span>;
}
function Hr({ style }) {
  return <hr className="divider" style={style} />;
}
function BackBtn({ onClick, label="Back" }) {
  return <button onClick={onClick} className="btn-text" style={{ fontSize:14, padding:"4px 0" }}>
    ← {label}
  </button>;
}
function TI({ label, value, onChange, placeholder, autoFocus, style, mic }) {
  // Local state prevents parent re-renders on every keystroke.
  // Parent is notified on blur (field commit) rather than each key.
  const [local, setLocal] = useState(value || "");
  // Sync inbound prop changes (e.g. undo, external updates) without clobbering typing
  const lastProp = useRef(value);
  if (value !== lastProp.current) { lastProp.current = value; setLocal(value || ""); }
  return <div style={{ marginBottom:12, ...style }}>
    {label && <Lbl>{label}</Lbl>}
    <div style={{ display:"flex", gap:6 }}>
      <input className="inp" value={local} placeholder={placeholder||""}
        autoFocus={autoFocus} style={{ flex:1 }}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => { onChange(e.target.value); }} />
      {mic && <MicButton onText={t => { const v = local ? local+" "+t : t; setLocal(v); onChange(v); }} />}
    </div>
  </div>;
}
function NI({ label, value, onChange, min, max, step, placeholder, style }) {
  const [local, setLocal] = useState(value ?? "");
  const lastProp = useRef(value);
  if (value !== lastProp.current) { lastProp.current = value; setLocal(value ?? ""); }
  return <div style={{ marginBottom:12, ...style }}>
    {label && <Lbl>{label}</Lbl>}
    <input className="inp" type="number" value={local} min={min} max={max} step={step||1}
      placeholder={placeholder||""} inputMode="numeric"
      onChange={e => setLocal(e.target.value)}
      onBlur={e => onChange(e.target.value === "" ? null : Number(e.target.value))} />
  </div>;
}
function SI({ label, value, onChange, options, style }) {
  return <div style={{ marginBottom:12, ...style }}>
    {label && <Lbl>{label}</Lbl>}
    <select className="inp" value={value||""} onChange={e=>onChange(e.target.value)}>
      <option value="">— select —</option>
      {options.map(o=><option key={o} value={o}>{o}</option>)}
    </select>
  </div>;
}
function TA({ label, value, onChange, placeholder, rows, style }) {
  const [local, setLocal] = useState(value || "");
  const lastProp = useRef(value);
  if (value !== lastProp.current) { lastProp.current = value; setLocal(value || ""); }
  return <div style={{ marginBottom:12, ...style }}>
    {label && <Lbl>{label}</Lbl>}
    <textarea className="inp" rows={rows||3} value={local} placeholder={placeholder||""}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => onChange(e.target.value)} />
  </div>;
}

// ─── AUTOCOMPLETE ─────────────────────────────────────────────────────────────
function ACI({ label, value, onChange, onCommit, suggestions=[], placeholder, style }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value || "");
  // Sync prop → local only when it changes externally (not while user is typing)
  const lastProp = useRef(value);
  if (value !== lastProp.current) { lastProp.current = value; setQ(value || ""); }
  // Filter suggestions without storing in state (no extra render per keystroke)
  const filtered = q
    ? suggestions.filter(s => s.toLowerCase().includes(q.toLowerCase()) && s !== q).slice(0, 8)
    : [];
  function commit(v) {
    const trimmed = v.trim();
    setQ(trimmed);
    lastProp.current = trimmed; // prevent prop-sync from clobbering after commit
    onChange(trimmed);
    onCommit?.(trimmed);
    setOpen(false);
  }
  return <div style={{ marginBottom:12, ...style }}>
    {label && <Lbl>{label}</Lbl>}
    <div className="ac-wrap" style={{ display:"flex", gap:6 }}>
      <input className="inp" value={q} placeholder={placeholder||""}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => commit(q), 160)}
        style={{ flex:1 }} />
      <MicButton onText={t => { setQ(t); setOpen(true); commit(t); }} />
      {open && filtered.length > 0 && (
        <div className="ac-list">
          {filtered.map(s => (
            <div key={s} className="ac-item mono" onMouseDown={() => commit(s)}>{s}</div>
          ))}
        </div>
      )}
    </div>
  </div>;
}

// ─── UNIT TOGGLE PILL ─────────────────────────────────────────────────────────
function UnitPill({ useCelsius, onChange }) {
  return <div className="unit-pill">
    <button className={!useCelsius?"active":""} onClick={()=>onChange(false)}>°F</button>
    <button className={useCelsius?"active":""} onClick={()=>onChange(true)}>°C</button>
  </div>;
}

// ─── ONLINE STATUS ────────────────────────────────────────────────────────────
function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(()=>{
    const on=()=>setOnline(true), off=()=>setOnline(false);
    window.addEventListener("online",on); window.addEventListener("offline",off);
    return ()=>{ window.removeEventListener("online",on); window.removeEventListener("offline",off); };
  },[]);
  return online;
}

// ─── SESSION TIMER ────────────────────────────────────────────────────────────
function SessionTimer({ startedAt }) {
  const [,tick] = useState(0);
  useEffect(()=>{ const t=setInterval(()=>tick(n=>n+1),1000); return ()=>clearInterval(t); },[]);
  return <span className="mono" style={{ fontSize:12, color:"var(--ink-faint)" }}>{fmtDuration(startedAt)}</span>;
}


// ─── DEADLINE ALARMS ──────────────────────────────────────────────────────────

// Web Audio API beep — no files, no permissions, works on all platforms.
// Pattern: three short beeps, urgency increases with repetition.
function playAlarmBeep(ctx) {
  const t = ctx.currentTime;
  [0, 0.35, 0.70].forEach(offset => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type      = "sine";
    osc.frequency.setValueAtTime(880, t + offset);           // A5
    osc.frequency.setValueAtTime(1320, t + offset + 0.08);   // E6 — rising chirp
    gain.gain.setValueAtTime(0, t + offset);
    gain.gain.linearRampToValueAtTime(0.6, t + offset + 0.02);
    gain.gain.linearRampToValueAtTime(0, t + offset + 0.22);
    osc.start(t + offset);
    osc.stop(t + offset + 0.25);
  });
}

// Single hook manages all deadline timers for one session's tests.
// Returns { alarmTest, dismissAlarm, snooze } for the AlarmModal.
function useDeadlines(tests, onSnoozeUpdate) {
  const [alarmTest, setAlarmTest] = useState(null);
  const audioCtxRef = useRef(null);
  const timersRef   = useRef({});         // testId → clearTimeout handle
  const titleRef    = useRef(document.title);
  const flashRef    = useRef(null);

  // Schedule or reschedule timers whenever test deadlines change
  useEffect(() => {
    // Clear all existing timers
    Object.values(timersRef.current).forEach(clearTimeout);
    timersRef.current = {};

    (tests || []).forEach(test => {
      if (!test.deadline) return;
      const ms = new Date(test.deadline).getTime() - Date.now();
      if (ms <= 0) return; // already past
      timersRef.current[test.id] = setTimeout(() => fireAlarm(test), ms);
    });

    return () => {
      Object.values(timersRef.current).forEach(clearTimeout);
      clearTimeout(flashRef.current);
      document.title = titleRef.current;
    };
  }, [JSON.stringify((tests||[]).map(t=>({ id:t.id, deadline:t.deadline })))]);

  function fireAlarm(test) {
    // Web Audio beep (no permission needed)
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume().then(() => playAlarmBeep(ctx));
      else playAlarmBeep(ctx);
    } catch(e) { /* audio blocked — visual alarm still fires */ }

    // Tab title flash
    let flash = false;
    clearInterval(flashRef.current);
    flashRef.current = setInterval(() => {
      document.title = (flash = !flash) ? `⚠ TEST DUE — ${test.name}` : titleRef.current;
    }, 800);

    // Web Notification (desktop/Android Chrome, granted permission only)
    if (Notification?.permission === "granted") {
      try {
        new Notification(`⏱ Test deadline: ${test.name}`, {
          body: test.deadlineLabel || "Test window is closing.",
          icon: "/favicon.ico",
          tag: `waxlab-${test.id}`,
        });
      } catch(e) { /* silently skip if blocked */ }
    }

    setAlarmTest(test);
  }

  function dismissAlarm() {
    clearInterval(flashRef.current);
    document.title = titleRef.current;
    setAlarmTest(null);
  }

  function snooze(test, minutes) {
    dismissAlarm();
    const newDeadline = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    onSnoozeUpdate(test.id, newDeadline);
  }

  return { alarmTest, dismissAlarm, snooze };
}

// ─── ALARM MODAL ──────────────────────────────────────────────────────────────

function AlarmModal({ test, onDismiss, onSnooze }) {
  // Pulse animation via inline keyframe injection
  useEffect(() => {
    const id = "wl-alarm-pulse";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = `@keyframes wl-pulse { 0%,100%{opacity:1} 50%{opacity:0.55} }`;
      document.head.appendChild(s);
    }
  }, []);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(200,40,30,0.92)", zIndex:3000,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      animation:"wl-pulse 1.2s ease-in-out infinite" }}>
      <div style={{ fontSize:72, marginBottom:16 }}>⏱</div>
      <div style={{ fontSize:24, fontWeight:800, color:"#fff", textAlign:"center",
        padding:"0 24px", marginBottom:8 }}>
        {test.name}
      </div>
      {test.deadlineLabel && (
        <div style={{ fontSize:15, color:"rgba(255,255,255,0.8)", marginBottom:24,
          textAlign:"center", padding:"0 24px" }}>
          {test.deadlineLabel}
        </div>
      )}
      <div style={{ fontSize:15, color:"rgba(255,255,255,0.7)", marginBottom:32 }}>
        TEST DEADLINE REACHED
      </div>
      <div style={{ display:"flex", gap:12, flexWrap:"wrap", justifyContent:"center",
        padding:"0 24px" }}>
        <button onClick={() => onSnooze(test, 5)}
          style={{ background:"rgba(255,255,255,0.2)", border:"2px solid rgba(255,255,255,0.5)",
            color:"#fff", borderRadius:8, padding:"12px 20px", fontSize:15,
            fontWeight:600, cursor:"pointer", minWidth:100 }}>
          +5 min
        </button>
        <button onClick={() => onSnooze(test, 10)}
          style={{ background:"rgba(255,255,255,0.2)", border:"2px solid rgba(255,255,255,0.5)",
            color:"#fff", borderRadius:8, padding:"12px 20px", fontSize:15,
            fontWeight:600, cursor:"pointer", minWidth:100 }}>
          +10 min
        </button>
        <button onClick={onDismiss}
          style={{ background:"#fff", border:"none", color:"#c82818",
            borderRadius:8, padding:"12px 24px", fontSize:15,
            fontWeight:700, cursor:"pointer", minWidth:120 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── DEADLINE COUNTDOWN BADGE ─────────────────────────────────────────────────

function CountdownBadge({ deadline }) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    function tick() {
      const ms = new Date(deadline).getTime() - Date.now();
      setRemaining(ms);
    }
    tick();
    const id = setInterval(tick, 10000); // update every 10s
    return () => clearInterval(id);
  }, [deadline]);

  if (remaining == null) return null;
  if (remaining <= 0) return (
    <span className="tag" style={{ background:"var(--red)", color:"#fff",
      fontSize:9, padding:"2px 6px", borderRadius:4 }}>DUE</span>
  );

  const totalMin = Math.ceil(remaining / 60000);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const label = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const urgent = remaining < 5 * 60 * 1000;   // < 5 min
  const warning = remaining < 15 * 60 * 1000; // < 15 min

  return (
    <span className="mono" style={{
      fontSize:11, fontWeight:600, padding:"2px 7px", borderRadius:4,
      background: urgent ? "var(--red)" : warning ? "var(--amber)" : "var(--paper-3)",
      color: (urgent||warning) ? "#fff" : "var(--ink-mid)",
    }}>
      ⏱ {label}
    </span>
  );
}

// ─── DEADLINE PICKER ──────────────────────────────────────────────────────────

function DeadlinePicker({ test, onSave, onClose }) {
  // Derive a sensible default time: today at next round hour
  function defaultTime() {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d.toTimeString().slice(0,5); // "HH:MM"
  }
  function defaultDate() {
    return new Date().toISOString().slice(0,10);
  }

  const existing = test.deadline ? new Date(test.deadline) : null;
  const [date,  setDate]  = useState(existing ? existing.toISOString().slice(0,10) : defaultDate());
  const [time,  setTime]  = useState(existing ? existing.toTimeString().slice(0,5)  : defaultTime());
  const [label, setLabel] = useState(test.deadlineLabel || "");

  function save() {
    const iso = new Date(`${date}T${time}:00`).toISOString();
    onSave({ deadline: iso, deadlineLabel: label.trim() });
    onClose();
  }
  function clear() {
    onSave({ deadline: null, deadlineLabel: "" });
    onClose();
  }

  // Request notification permission on first interaction (desktop/Android bonus)
  function requestNotifPermission() {
    if (Notification?.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  return (
    <div onClick={onClose}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:400 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ position:"fixed", bottom:0, left:0, right:0, background:"var(--paper)",
          borderRadius:"16px 16px 0 0", padding:"20px 20px 40px", zIndex:401 }}>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          marginBottom:16 }}>
          <span style={{ fontSize:17, fontWeight:700 }}>Set Deadline</span>
          <button onClick={onClose} className="btn-text" style={{ fontSize:24 }}>×</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
          <div>
            <Lbl>Date</Lbl>
            <input className="inp" type="date" value={date}
              onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <Lbl>Time</Lbl>
            <input className="inp" type="time" value={time}
              onChange={e => setTime(e.target.value)} />
          </div>
        </div>

        <TI label="Label (optional)" value={label} onChange={setLabel}
          placeholder="e.g. Glide test cutoff" style={{ marginBottom:16 }} />

        {Notification?.permission === "default" && (
          <div style={{ marginBottom:12, padding:"10px 12px", background:"var(--paper-2)",
            borderRadius:6, fontSize:12, color:"var(--ink-mid)", lineHeight:1.5 }}>
            💡 Allow notifications for an extra system alert when this deadline fires —
            useful if WaxLab is in the background.
            <button onClick={requestNotifPermission}
              style={{ display:"block", marginTop:6, fontSize:12, fontWeight:600,
                color:"var(--blue)", background:"none", border:"none", cursor:"pointer",
                padding:0 }}>
              Enable notifications →
            </button>
          </div>
        )}

        <div style={{ display:"flex", gap:8 }}>
          <button className="btn" style={{ flex:2 }} onClick={save}>Set Deadline</button>
          {test.deadline && (
            <button className="btn-ghost" style={{ flex:1 }} onClick={clear}>Clear</button>
          )}
          <button className="btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}


// ─── VOICE / SPEECH ───────────────────────────────────────────────────────────

// Low-level mic hook: manages a SpeechRecognition session.
// onResult(transcript) fires each time speech is finalised.
// Returns { listening, supported, start, stop }
function useMic(onResult) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  const supported = typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  function start() {
    if (!supported || listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult  = e => onResult(e.results[0][0].transcript);
    rec.onerror   = () => setListening(false);
    rec.onend     = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  }

  function stop() {
    recRef.current?.stop();
    setListening(false);
  }

  // Cleanup on unmount
  useEffect(() => () => recRef.current?.stop(), []);

  return { listening, supported, start, stop };
}

// MicButton: inline mic icon that appends dictated text to a field.
// Renders nothing on unsupported browsers (Firefox).
function MicButton({ onText, style }) {
  const { listening, supported, start, stop } = useMic(transcript => {
    onText(transcript);
  });
  if (!supported) return null;
  return (
    <button
      onMouseDown={e => e.preventDefault()} // prevent blur on adjacent input
      onClick={listening ? stop : start}
      style={{
        background: listening ? "var(--red)" : "var(--paper-3)",
        border: "1.5px solid var(--rule)",
        borderRadius: 6,
        color: listening ? "#fff" : "var(--ink-mid)",
        cursor: "pointer",
        fontSize: 16,
        lineHeight: 1,
        minHeight: 38,
        minWidth: 38,
        padding: "0 10px",
        flexShrink: 0,
        ...style,
      }}>
      {listening ? "⏹" : "🎙"}
    </button>
  );
}

// ─── VOICE COMMAND PARSER ─────────────────────────────────────────────────────
// Handles real-world speech recognition quirks:
//   "a 1"   instead of "a1"  (space between letter and digit)
//   "ay one" instead of "a1" (phonetic letter + word number)
//   "race"  instead of "rate" (sounds similar)
//   "keep"  instead of "advance", "drop" instead of "eliminate", etc.
//   Word-order flexibility: "glide 8 kick 4 a1" works same as "a1 glide 8 kick 4"
//
// Returns: { action, skiId, glide?, kick? }  or  null

function normaliseTranscript(transcript) {
  let t = transcript.toLowerCase().trim();

  // 1. Number words → digits (zero through ten)
  const numWords = {zero:0,one:1,two:2,three:3,four:4,five:5,
                    six:6,seven:7,eight:8,nine:9,ten:10};
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
    m => numWords[m]);

  // 2. Phonetic letter names → actual letters
  //    Order: longer/more specific patterns first to avoid partial matches
  const phoneticLetters = [
    [/\bdouble\s*you\b/g, "w"],
    [/\baye?\b/g,   "a"],  // "ay" or "a"
    [/\bbee?\b/g,   "b"],  // "bee" or "be"
    [/\bsee\b/g,    "c"],  [/\bsea\b/g,  "c"],
    [/\bdee?\b/g,   "d"],
    [/\beff\b/g,    "f"],
    [/\bjee\b/g,    "g"],
    [/\baitch\b/g,  "h"],
    [/\beye\b/g,    "i"],
    [/\bjay\b/g,    "j"],
    [/\bkay\b/g,    "k"],
    [/\bell\b/g,    "l"],
    [/\bem\b/g,     "m"],
    [/\ben\b/g,     "n"],
    [/\boh\b/g,     "o"],
    [/\bpee\b/g,    "p"],
    [/\bcue\b/g,    "q"],
    [/\barr?\b/g,   "r"],
    [/\bess\b/g,    "s"],
    [/\btee\b/g,    "t"],
    [/\byou\b/g,    "u"],
    [/\bvee\b/g,    "v"],
    [/\bex\b/g,     "x"],
    [/\bwhy\b/g,    "y"],
    [/\bzee\b/g,    "z"],
  ];
  for (const [pat, rep] of phoneticLetters) t = t.replace(pat, rep);

  // 3. Collapse multi-word phrases before filler removal
  t = t.replace(/\brunner\s+up\b/g, "runnerup");
  t = t.replace(/\b(vs\.?|versus)\b/g, "versus");
  // Remove filler words that don't carry meaning
  t = t.replace(/\b(ski|the|is|to|and|or|number)\b/g, " ");

  // 4. Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();

  // 5. Merge "letter(s) space digit(s)" → ski ID token: "a 1" → "a1", "b 12" → "b12"
  t = t.replace(/\b([a-z]{1,2})\s+(\d{1,2})\b/g, "$1$2");

  return t;
}

function parseVoiceCommand(transcript, knownIds) {
  const norm = normaliseTranscript(transcript);
  const knownUpper = (knownIds || []).map(id => id.toUpperCase());

  // Extract first ski ID token (letter+digit, 1–4 chars total)
  function extractId(str) {
    const m = str.match(/\b([a-z]{1,2}\d{1,2})\b/i);
    if (!m) return null;
    const candidate = m[1].toUpperCase();
    // Accept known fleet IDs preferentially; otherwise accept any letter+digit pattern
    if (knownUpper.length > 0 && knownUpper.includes(candidate)) return candidate;
    if (/^[A-Z]{1,2}\d{1,2}$/.test(candidate)) return candidate;
    return null;
  }

  // Extract a numeric rating (1-10) that follows OR precedes a keyword
  function extractRating(str, keyword) {
    // After keyword: "glide 8", "glide:8"
    let m = str.match(new RegExp(keyword + "[\\s:]*?(\\d{1,2})\\b"));
    if (m) { const v = parseInt(m[1]); if (v >= 1 && v <= 10) return v; }
    // Before keyword: "8 glide", "5glide"
    m = str.match(new RegExp("\\b(\\d{1,2})[\\s]*" + keyword));
    if (m) { const v = parseInt(m[1]); if (v >= 1 && v <= 10) return v; }
    return null;
  }

  // Action synonyms — first match wins
  const actionMap = [
    { action: "advance",   words: ["advance","advanced","next","pass","keep","forward","promote"] },
    { action: "eliminate", words: ["eliminate","eliminated","out","drop","remove","scratch","discard"] },
    { action: "winner",    words: ["winner","winners","win","wins","first","best","choose","select"] },
    { action: "runnerup",  words: ["runnerup","runner","second","2nd","silver","place2"] },
    { action: "pair",      words: ["pair","compare","versus","vs","match","test"] },
    { action: "restore",   words: ["restore","back","revive","return","undo"] },
    { action: "rate",      words: ["rate","rated","rating","race","score","scored","mark"] },
  ];

  let detectedAction = null;
  for (const { action, words } of actionMap) {
    if (words.some(w => new RegExp("\\b" + w + "\\b").test(norm))) {
      detectedAction = action;
      break;
    }
  }

  const skiId = extractId(norm);

  // Extract a second ski ID for pair commands
  function extractSecondId(str, firstId) {
    const matches = [...str.matchAll(/\b([a-z]{1,2}\d{1,2})\b/gi)];
    for (const m of matches) {
      const candidate = m[1].toUpperCase();
      if (candidate === firstId) continue;
      if (knownUpper.length > 0 && knownUpper.includes(candidate)) return candidate;
      if (/^[A-Z]{1,2}\d{1,2}$/.test(candidate)) return candidate;
    }
    return null;
  }

  // Pair — needs two ski IDs: "pair A1 B2", "compare A1 and B2", "A1 versus B2"
  if (detectedAction === "pair") {
    const id2 = skiId ? extractSecondId(norm, skiId) : null;
    if (skiId && id2) return { action: "pair", skiId, skiId2: id2 };
    return null;
  }

  // Runner-up — needs one ski ID
  if (detectedAction === "runnerup") {
    if (skiId) return { action: "runnerup", skiId };
    return null;
  }

  // Advance / eliminate / winner / restore — need a ski ID
  if (detectedAction && detectedAction !== "rate") {
    if (skiId) return { action: detectedAction, skiId };
    return null;
  }

  // Rating — explicit "rate A1 glide 8 kick 4" or implicit "A1 glide 7"
  // For implicit, we require at least one of glide/kick keyword + number
  const glide = extractRating(norm, "glide");
  const kick  = extractRating(norm, "kick");

  if (skiId && (glide != null || kick != null)) {
    return { action: "rate", skiId, glide, kick };
  }

  // Explicit "rate" command present but missing some parts → still try
  if (detectedAction === "rate" && skiId) {
    return { action: "rate", skiId, glide, kick };
  }

  return null; // nothing recognised
}


// VoiceCommandBar: shown in Tournament tab. Mic button → parses speech →
// shows a confirmation chip → user taps confirm or cancel.
function VoiceCommandBar({ skis, isGlide, onAdvance, onEliminate, onWinner, onRestore, onRate, onPair, onRunnerUp }) {
  const [pending, setPending] = useState(null); // parsed command awaiting confirm

  const knownIds = (skis || []).map(s => s.id);

  const { listening, supported, start, stop } = useMic(transcript => {
    const cmd = parseVoiceCommand(transcript, knownIds);
    if (cmd) setPending({ ...cmd, _raw: transcript });
    else setPending({ action: "unknown", raw: transcript });
  });

  if (!supported) return null;

  function confirm() {
    if (!pending || pending.action === "unknown") { setPending(null); return; }
    const { action, skiId, skiId2, glide, kick } = pending;
    if (action === "advance")   onAdvance?.(skiId);
    if (action === "eliminate") onEliminate?.(skiId);
    if (action === "winner")    onWinner?.(skiId);
    if (action === "restore")   onRestore?.(skiId);
    if (action === "rate")      onRate?.(skiId, { glide, kick });
    if (action === "pair")      onPair?.(skiId, skiId2);
    if (action === "runnerup")  onRunnerUp?.(skiId);
    setPending(null);
  }

  function describeCommand(cmd) {
    if (cmd.action === "unknown") return `Not understood: "${cmd.raw}"`;
    if (cmd.action === "advance")   return `Advance ${cmd.skiId}`;
    if (cmd.action === "eliminate") return `Eliminate ${cmd.skiId}`;
    if (cmd.action === "winner")    return `Declare winner: ${cmd.skiId}`;
    if (cmd.action === "restore")   return `Restore ${cmd.skiId}`;
    if (cmd.action === "pair")      return `Set pair: ${cmd.skiId} vs ${cmd.skiId2}`;
    if (cmd.action === "runnerup")  return `Mark runner-up: ${cmd.skiId}`;
    if (cmd.action === "rate") {
      const parts = [];
      if (cmd.glide != null) parts.push(`glide ${cmd.glide}`);
      if (cmd.kick  != null && !isGlide) parts.push(`kick ${cmd.kick}`);
      return `Rate ${cmd.skiId}: ${parts.join(", ")}`;
    }
    return cmd.action;
  }

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Pending command confirmation chip */}
      {pending && (
        <div style={{ padding: "10px 14px", background: "var(--paper-2)",
          borderRadius: 8, marginBottom: 8, border: "1.5px solid var(--rule)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            {pending.action === "unknown" ? "⚠ " : "🎙 "}
            {describeCommand(pending)}
          </div>
          {pending.action !== "unknown" && pending._raw && (
            <div style={{ fontSize: 10, color: "var(--ink-faint)", marginBottom: 6, fontStyle: "italic" }}>
              heard: "{pending._raw}"
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {pending.action !== "unknown" && (
              <button className="btn" style={{ flex: 1, fontSize: 13, padding: "8px 0" }}
                onClick={confirm}>Confirm</button>
            )}
            <button className="btn-ghost" style={{ flex: 1, fontSize: 13, padding: "8px 0" }}
              onClick={() => setPending(null)}>
              {pending.action === "unknown" ? "Dismiss" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Mic trigger button */}
      <button
        onClick={listening ? stop : start}
        className={listening ? "btn" : "btn-ghost"}
        style={{ width: "100%", fontSize: 14, padding: "10px 0",
          background: listening ? "var(--red)" : undefined,
          color: listening ? "#fff" : undefined,
          borderColor: listening ? "var(--red)" : undefined }}>
        {listening ? "⏹ Listening… tap to stop" : "🎙 Voice Command"}
      </button>

      {/* Hint text */}
      {!listening && !pending && (
        <div style={{ fontSize: 11, color: "var(--ink-faint)", textAlign: "center",
          marginTop: 6, lineHeight: 1.6 }}>
          <div>"Advance A1" · "Eliminate B2" · "Winner C1"</div>
          <div>"Pair A1 B2" · "Runner up A1" · "Second B2"</div>
          <div>"Rate A1 glide 8 kick 4" · "A1 glide seven"</div>
          <div style={{ marginTop: 3, color: "var(--rule)" }}>Also: keep/drop/pass · compare · versus · ay-one</div>
        </div>
      )}
    </div>
  );
}


// ─── FLEET REGISTRY VIEW ──────────────────────────────────────────────────────
// Manages the team's named ski fleet definitions.
// Accessible from TeamBar via a "Fleets" button (or from Home).

function FleetSkiRow({ ski, onChange, onDelete }) {
  return (
    <div style={{ display:"flex", gap:6, alignItems:"flex-start", marginBottom:8,
      padding:"10px 12px", background:"var(--paper-3)", borderRadius:6 }}>
      <div style={{ flex:"0 0 64px" }}>
        <Lbl>ID</Lbl>
        <input className="inp mono" value={ski.id}
          onChange={e => onChange({ ...ski, id: e.target.value.toUpperCase() })}
          style={{ padding:"6px 8px", fontSize:14, fontWeight:700, letterSpacing:"0.06em" }} />
      </div>
      <div style={{ flex:"1 1 90px" }}>
        <Lbl>Make / Model</Lbl>
        <input className="inp" value={ski.make||""}
          onChange={e => onChange({ ...ski, make: e.target.value })}
          placeholder="e.g. Fischer" style={{ padding:"6px 8px", fontSize:13 }} />
      </div>
      <div style={{ flex:"0 0 70px" }}>
        <Lbl>Flex</Lbl>
        <input className="inp" value={ski.flex||""}
          onChange={e => onChange({ ...ski, flex: e.target.value })}
          placeholder="e.g. 54" style={{ padding:"6px 8px", fontSize:13 }} />
      </div>
      <div style={{ flex:"0 0 80px" }}>
        <Lbl>Grind</Lbl>
        <input className="inp" value={ski.grind||""}
          onChange={e => onChange({ ...ski, grind: e.target.value })}
          placeholder="e.g. HF3" style={{ padding:"6px 8px", fontSize:13 }} />
      </div>
      <div style={{ flex:"0 0 28px", paddingTop:22 }}>
        <button onClick={onDelete} className="btn-text"
          style={{ fontSize:20, color:"var(--red)", padding:"0 4px" }}>×</button>
      </div>
    </div>
  );
}

function FleetCard({ fleet, onChange, onDelete }) {
  const [expanded, setExpanded] = useState(true);

  function updSki(idx, patch) {
    const skis = fleet.skis.map((s, i) => i === idx ? patch : s);
    onChange({ ...fleet, skis });
  }
  function addSki() {
    // Auto-suggest next ID in this fleet's sequence
    const ids = fleet.skis.map(s => s.id).filter(Boolean);
    let nextId = "";
    if (ids.length > 0) {
      const last = ids[ids.length - 1];
      const m = last.match(/^([A-Z]+)(\d+)$/);
      if (m) nextId = m[1] + (parseInt(m[2]) + 1);
    }
    onChange({ ...fleet, skis: [...fleet.skis, { id: nextId, make:"", flex:"", grind:"", notes:"" }] });
  }
  function removeSki(idx) {
    onChange({ ...fleet, skis: fleet.skis.filter((_, i) => i !== idx) });
  }

  return (
    <div className="card" style={{ marginBottom:12 }}>
      {/* Fleet header */}
      <div style={{ padding:"12px 14px", display:"flex", justifyContent:"space-between",
        alignItems:"center" }}>
        <div style={{ flex:1, marginRight:8 }}>
          <input className="inp" value={fleet.name}
            onChange={e => onChange({ ...fleet, name: e.target.value })}
            placeholder="Fleet name (e.g. A-team glide skis)"
            style={{ fontWeight:700, fontSize:15, marginBottom:0 }} />
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center", flexShrink:0 }}>
          <select className="inp" value={fleet.category}
            onChange={e => onChange({ ...fleet, category: e.target.value })}
            style={{ fontSize:12, padding:"6px 10px", width:"auto" }}>
            <option value="glide">Glide</option>
            <option value="kick">Kick</option>
          </select>
          <button className="btn-ghost"
            style={{ fontSize:12, padding:"6px 10px", minHeight:34 }}
            onClick={() => setExpanded(x => !x)}>
            {expanded ? "Collapse" : `${fleet.skis.length} ski${fleet.skis.length !== 1 ? "s" : ""}`}
          </button>
          <button onClick={onDelete} className="btn-text"
            style={{ fontSize:20, color:"var(--red)", padding:"0 4px" }}>×</button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding:"0 14px 12px", borderTop:"1px solid var(--rule)" }}>
          {fleet.skis.length === 0 && (
            <div style={{ fontSize:13, color:"var(--ink-faint)", padding:"10px 0" }}>
              No skis yet. Tap + Add Ski below.
            </div>
          )}
          {/* Column headers */}
          {fleet.skis.length > 0 && (
            <div style={{ display:"flex", gap:6, paddingTop:10, paddingBottom:2 }}>
              <div style={{ flex:"0 0 64px" }}><Lbl>ID</Lbl></div>
              <div style={{ flex:"1 1 90px" }}><Lbl>Make / Model</Lbl></div>
              <div style={{ flex:"0 0 70px" }}><Lbl>Flex</Lbl></div>
              <div style={{ flex:"0 0 80px" }}><Lbl>Grind</Lbl></div>
              <div style={{ flex:"0 0 28px" }} />
            </div>
          )}
          {fleet.skis.map((ski, i) => (
            <FleetSkiRow key={i} ski={ski}
              onChange={patch => updSki(i, patch)}
              onDelete={() => removeSki(i)} />
          ))}
          {/* Notes for the whole fleet */}
          <TA label="Fleet Notes" value={fleet.notes||""}
            onChange={v => onChange({ ...fleet, notes: v })}
            placeholder="General notes about this fleet (age, storage, history…)"
            rows={2} style={{ marginTop:4, marginBottom:8 }} />
          <button className="btn-ghost" onClick={addSki}
            style={{ width:"100%", fontSize:13, padding:"8px 0" }}>
            + Add Ski
          </button>
        </div>
      )}
    </div>
  );
}

function FleetRegistryView({ teamCode, fleets: fleetsProp, onSave, onBack }) {
  const [fleets, setFleets] = useState(fleetsProp || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  // Sync if parent updates (e.g. real-time from another device)
  const lastProp = useRef(fleetsProp);
  if (fleetsProp !== lastProp.current) { lastProp.current = fleetsProp; setFleets(fleetsProp || []); }

  async function persist(updated) {
    setFleets(updated);
    setSaving(true); setSaved(false);
    await onSave(updated);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  function addFleet(category) {
    const existing = (fleets || []).filter(f => f.category === category);
    const name = category === "glide"
      ? `Glide Fleet ${existing.length + 1}`
      : `Kick Fleet ${existing.length + 1}`;
    // Auto-populate IDs: glide fleets use A1/A2…, kick use K1/K2… by default
    const prefix = category === "glide"
      ? String.fromCharCode(65 + existing.length)   // A, B, C…
      : "K";
    const skis = [1,2,3,4].map(n => ({ id:`${prefix}${n}`, make:"", flex:"", grind:"", notes:"" }));
    persist([...(fleets || []), { id: uid(), name, category, skis, notes:"" }]);
  }

  function updateFleet(id, patch) {
    persist((fleets || []).map(f => f.id === id ? patch : f));
  }

  function deleteFleet(id) {
    if (!window.confirm("Delete this fleet?")) return;
    persist((fleets || []).filter(f => f.id !== id));
  }

  if (fleets === null) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
      height:"100vh", fontSize:14, color:"var(--ink-faint)" }}>Loading…</div>
  );

  const glideFleets = fleets.filter(f => f.category === "glide");
  const kickFleets  = fleets.filter(f => f.category === "kick");

  return (
    <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
      <div className="view-header">
        <BackBtn onClick={onBack} />
        <div style={{ fontSize:15, fontWeight:700 }}>Fleet Registry</div>
        <div style={{ fontSize:12, color: saving ? "var(--amber)" : saved ? "var(--green)" : "transparent",
          fontWeight:600, minWidth:40, textAlign:"right" }}>
          {saving ? "Saving…" : saved ? "✓ Saved" : ""}
        </div>
      </div>

      <div style={{ padding:16, paddingBottom:60 }}>
        <div style={{ fontSize:13, color:"var(--ink-mid)", marginBottom:16, lineHeight:1.6 }}>
          Define your team's ski fleets here. Ski IDs and specs will appear as preset
          options when you set up a new test — tap a fleet to pre-populate the whole fleet
          into a test's ski list in one tap.
        </div>

        {/* Supabase note if not configured */}
        {!supabaseConfigured && (
          <div style={{ padding:"10px 12px", background:"var(--paper-2)", borderRadius:6,
            fontSize:12, color:"var(--ink-faint)", marginBottom:16, lineHeight:1.5 }}>
            ⚠ Supabase not configured — fleets are saved on this device only.
            Configure Supabase to share fleet definitions with your whole team.
          </div>
        )}

        {/* Glide fleets */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          marginBottom:10 }}>
          <Lbl style={{ marginBottom:0 }}>Glide Fleets</Lbl>
          <button className="btn-ghost" onClick={() => addFleet("glide")}
            style={{ fontSize:12, padding:"6px 14px", minHeight:34 }}>
            + New Glide Fleet
          </button>
        </div>
        {glideFleets.length === 0 && (
          <div style={{ fontSize:13, color:"var(--ink-faint)", marginBottom:12 }}>
            No glide fleets defined yet.
          </div>
        )}
        {glideFleets.map(f => (
          <FleetCard key={f.id} fleet={f}
            onChange={patch => updateFleet(f.id, patch)}
            onDelete={() => deleteFleet(f.id)} />
        ))}

        <Hr />

        {/* Kick fleets */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          marginBottom:10 }}>
          <Lbl style={{ marginBottom:0 }}>Kick Fleets</Lbl>
          <button className="btn-ghost" onClick={() => addFleet("kick")}
            style={{ fontSize:12, padding:"6px 14px", minHeight:34 }}>
            + New Kick Fleet
          </button>
        </div>
        {kickFleets.length === 0 && (
          <div style={{ fontSize:13, color:"var(--ink-faint)", marginBottom:12 }}>
            No kick fleets defined yet.
          </div>
        )}
        {kickFleets.map(f => (
          <FleetCard key={f.id} fleet={f}
            onChange={patch => updateFleet(f.id, patch)}
            onDelete={() => deleteFleet(f.id)} />
        ))}
      </div>
    </div>
  );
}


// ─── GLIDE-OUT TEST ───────────────────────────────────────────────────────────
// Paired descent protocol: two skiers go down together, swap, measure cm difference.
// Data model:
//   test.protocol = "glideout"
//   test.glideOutRuns = [{
//     id, label, skiA, skiB,       // which skis were compared
//     runAB: { cmAhead, notes },   // A vs B — positive = A faster
//     runBA: { cmAhead, notes },   // B vs A (skis swapped) — positive = B faster
//     ts
//   }]
//
// Net advantage of A over B = (runAB.cmAhead - runBA.cmAhead) / 2
// Reported: winner 0, loser +Ncm (lower is faster, 0 = winner baseline)


function calcGlideOutResults(comparisons, skis) {
  // Aggregate net advantage across all completed comparisons (both legs done).
  // Each comparison: two skis go down together, swap, measure again.
  // Net advantage of skiA over skiB = (legA_cmAhead − legB_cmAhead) / 2
  const totals = {};  // skiId → { totalNet, count }
  (comparisons || []).forEach(c => {
    const aCm = c.legA?.cmAhead ?? null;
    const bCm = c.legB?.cmAhead ?? null;
    if (aCm == null || bCm == null) return;  // incomplete — skip
    const netA = (aCm - bCm) / 2;
    if (!totals[c.skiA]) totals[c.skiA] = { totalNet:0, count:0 };
    if (!totals[c.skiB]) totals[c.skiB] = { totalNet:0, count:0 };
    totals[c.skiA].totalNet += netA;
    totals[c.skiA].count   += 1;
    totals[c.skiB].totalNet -= netA;
    totals[c.skiB].count   += 1;
  });
  const entries = Object.entries(totals)
    .map(([id, { totalNet, count }]) => ({ id, avg: totalNet / count, count }))
    .sort((a, b) => b.avg - a.avg);
  if (!entries.length) return [];
  const best = entries[0].avg;
  return entries.map(e => ({
    skiId: e.id,
    product:     skis?.find(s => s.id === e.id)?.product     || "",
    application: skis?.find(s => s.id === e.id)?.application || "",
    cmGap:     Math.round((best - e.avg) * 10) / 10,
    compCount: e.count,
  }));
}

// Suggest the next comparison: the pair with the fewest completed comparisons.
// Breaks ties by alphabetical order so the suggestion is deterministic.
function suggestNextComparison(comparisons, skis) {
  const ids = (skis || []).filter(s => s.standing !== "Eliminated").map(s => s.id);
  if (ids.length < 2) return null;
  const counts = {};
  for (let i = 0; i < ids.length; i++)
    for (let j = i+1; j < ids.length; j++)
      counts[`${ids[i]}|${ids[j]}`] = 0;
  (comparisons || []).filter(c => c.legA?.cmAhead != null && c.legB?.cmAhead != null)
    .forEach(c => {
      const key = [c.skiA, c.skiB].sort().join("|");
      if (key in counts) counts[key]++;
    });
  const sorted = Object.entries(counts).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  if (!sorted.length) return null;
  const [a, b] = sorted[0][0].split("|");
  return { skiA: a, skiB: b, timesRun: sorted[0][1] };
}

function GlideOutComparisonCard({ comp, skis, isBlind, onUpdate, onDelete }) {
  const [open, setOpen] = useState(!( comp.legA?.cmAhead != null && comp.legB?.cmAhead != null ));

  const skiLabel = id => {
    if (isBlind) return id;
    const s = skis?.find(x => x.id === id);
    return s?.product ? `${id} — ${s.product}` : id;
  };

  const complete = comp.legA?.cmAhead != null && comp.legB?.cmAhead != null;
  const netA = complete ? (comp.legA.cmAhead - comp.legB.cmAhead) / 2 : null;
  const faster = netA == null ? null : Math.abs(netA) < 0.5 ? null : netA > 0 ? comp.skiA : comp.skiB;
  const gap = netA == null ? null : Math.abs(netA);

  function updLeg(leg, field, val) {
    onUpdate({ ...comp, [leg]: { ...(comp[leg]||{}), [field]: val } });
  }

  return (
    <div className="card" style={{ marginBottom:8 }}>
      {/* Header row */}
      <div onClick={() => setOpen(o => !o)}
        style={{ padding:"11px 14px", display:"flex", justifyContent:"space-between",
          alignItems:"center", cursor:"pointer" }}>
        <div>
          <span style={{ fontWeight:700, fontSize:14 }}>
            {comp.label || `Comparison ${comp.num}`}
          </span>
          <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginLeft:8 }}>
            {comp.skiA} vs {comp.skiB}
          </span>
          {comp.testers && (
            <span style={{ fontSize:11, color:"var(--ink-faint)", marginLeft:8 }}>
              · {comp.testers}
            </span>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {complete && (
            <span className="mono" style={{ fontSize:13, fontWeight:700,
              color: gap < 1 ? "var(--ink-faint)" : "var(--green)" }}>
              {faster ? `${faster} +${gap.toFixed(1)}cm` : "Even"}
            </span>
          )}
          {!complete && <span className="tag" style={{ fontSize:9, color:"var(--amber)" }}>in progress</span>}
          <span style={{ color:"var(--ink-faint)", fontSize:12 }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding:"0 14px 14px", borderTop:"1px solid var(--rule)" }}>

          {/* Leg A */}
          <div style={{ marginTop:12, marginBottom:10, padding:"10px 12px",
            background:"var(--paper-3)", borderRadius:6 }}>
            <Lbl style={{ marginBottom:4 }}>
              Leg A — {skiLabel(comp.skiA)} leads
            </Lbl>
            <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8, lineHeight:1.5 }}>
              Skier wearing <strong className="mono">{comp.skiA}</strong> is the lead partner.
              After release, measure how many cm <strong className="mono">{comp.skiA}</strong> is ahead
              at the measurement point. Enter a negative number if behind.
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
              <div>
                <Lbl>{comp.skiA} cm ahead</Lbl>
                <input className="inp mono" type="number" inputMode="decimal"
                  value={comp.legA?.cmAhead ?? ""}
                  onChange={e => updLeg("legA","cmAhead", e.target.value===""?null:parseFloat(e.target.value))}
                  placeholder="e.g. 50"
                  style={{ fontSize:20, fontWeight:700, textAlign:"center" }} />
              </div>
              <div>
                <Lbl>Tester(s)</Lbl>
                <input className="inp" value={comp.testers||""}
                  onChange={e => onUpdate({ ...comp, testers: e.target.value })}
                  placeholder="initials or names" style={{ fontSize:13 }} />
              </div>
            </div>
            <TA label="Notes" value={comp.legA?.notes||""} rows={1}
              onChange={v => updLeg("legA","notes",v)}
              placeholder="Track, conditions, timing…" style={{ marginBottom:0 }} />
          </div>

          {/* Leg B — skis swapped */}
          <div style={{ marginBottom:10, padding:"10px 12px",
            background:"var(--paper-3)", borderRadius:6 }}>
            <Lbl style={{ marginBottom:4 }}>
              Leg B — {skiLabel(comp.skiB)} leads (skis swapped)
            </Lbl>
            <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8, lineHeight:1.5 }}>
              Skiers swap skis. Skier now wearing <strong className="mono">{comp.skiB}</strong> leads.
              Enter how many cm <strong className="mono">{comp.skiB}</strong> is ahead. Negative if behind.
            </div>
            <div>
              <Lbl>{comp.skiB} cm ahead</Lbl>
              <input className="inp mono" type="number" inputMode="decimal"
                value={comp.legB?.cmAhead ?? ""}
                onChange={e => updLeg("legB","cmAhead", e.target.value===""?null:parseFloat(e.target.value))}
                placeholder="e.g. 30"
                style={{ fontSize:20, fontWeight:700, textAlign:"center", marginBottom:8 }} />
            </div>
            <TA label="Notes" value={comp.legB?.notes||""} rows={1}
              onChange={v => updLeg("legB","notes",v)}
              placeholder="Track, conditions, timing…" style={{ marginBottom:0 }} />
          </div>

          {/* Result for this comparison */}
          {complete && (
            <div style={{ padding:"10px 12px", background:"var(--paper-2)", borderRadius:6,
              border:"1.5px solid var(--rule)", marginBottom:8 }}>
              <Lbl style={{ marginBottom:4 }}>Comparison result</Lbl>
              <div className="mono" style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:4 }}>
                Leg A: {comp.skiA} {comp.legA.cmAhead >= 0 ? "+" : ""}{comp.legA.cmAhead}cm
                &nbsp;·&nbsp;
                Leg B: {comp.skiB} {comp.legB.cmAhead >= 0 ? "+" : ""}{comp.legB.cmAhead}cm
              </div>
              <div style={{ fontSize:15, fontWeight:700,
                color: gap < 0.5 ? "var(--ink-faint)" : "var(--green)" }}>
                {gap < 0.5
                  ? "Even — no meaningful difference"
                  : `${faster} is faster by ${gap.toFixed(1)} cm net`}
              </div>
              <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginTop:4 }}>
                Formula: ({comp.legA.cmAhead} − {comp.legB.cmAhead}) ÷ 2 = {netA.toFixed(1)} cm
                → {comp.skiA}: 0 cm, {comp.skiB}: {netA > 0 ? "+" : ""}{(-netA).toFixed(1)} cm
              </div>
            </div>
          )}

          <button onClick={onDelete} className="btn-text"
            style={{ color:"var(--red)", fontSize:12, padding:"4px 0" }}>
            Delete this comparison
          </button>
        </div>
      )}
    </div>
  );
}

function GlideOutTab({ test, onUpdate, isBlind }) {
  const comparisons = test.glideOutRuns || [];
  const activeSkis  = (test.skis || []).filter(s => s.standing !== "Eliminated");
  const hasWinner   = test.skis?.some(s => s.standing === "Winner");

  const suggested = suggestNextComparison(comparisons, activeSkis);
  const [skiA, setSkiA] = useState(suggested?.skiA || "");
  const [skiB, setSkiB] = useState(suggested?.skiB || "");
  const [testers, setTesters] = useState("");

  // Keep dropdowns in sync with suggestion when comparisons change
  const prevSug = useRef(null);
  const newSug = suggestNextComparison(comparisons, activeSkis);
  if (newSug && JSON.stringify(newSug) !== JSON.stringify(prevSug.current)) {
    prevSug.current = newSug;
    if (!skiA && !skiB) { setSkiA(newSug.skiA); setSkiB(newSug.skiB); }
  }

  function upd(patch) { onUpdate({ ...test, ...patch }); }

  function addComparison() {
    if (!skiA || !skiB || skiA === skiB) return;
    const num = comparisons.length + 1;
    const comp = {
      id: uid(), num,
      label: `Comparison ${num}`,
      skiA, skiB, testers,
      legA: { cmAhead: null, notes: "" },
      legB: { cmAhead: null, notes: "" },
      ts: nowStr(),
    };
    upd({ glideOutRuns: [...comparisons, comp] });
    // Advance suggestion
    const next = suggestNextComparison([...comparisons, comp], activeSkis);
    if (next) { setSkiA(next.skiA); setSkiB(next.skiB); }
  }

  function updateComp(id, patch) {
    upd({ glideOutRuns: comparisons.map(c => c.id === id ? patch : c) });
  }
  function deleteComp(id) {
    upd({ glideOutRuns: comparisons.filter(c => c.id !== id) });
  }

  const results = calcGlideOutResults(comparisons, test.skis);
  const completedCount = comparisons.filter(c => c.legA?.cmAhead != null && c.legB?.cmAhead != null).length;

  // How many comparisons needed to fully round-robin
  const n = activeSkis.length;
  const totalPairs = n * (n - 1) / 2;

  return (
    <div>
      {/* Protocol reminder */}
      <div style={{ padding:"10px 14px", background:"var(--paper-2)", borderRadius:8,
        marginBottom:16, border:"1.5px solid var(--rule)", fontSize:12,
        color:"var(--ink-mid)", lineHeight:1.6 }}>
        <strong>Protocol:</strong> 1–3 double poles from start, then tuck.
        Lead partner holds second partner to match speed, releases at the release point.
        Both hold tuck. Measure cm gap at measurement point. Swap skis and repeat the same run.
        Net = (leg A cm − leg B cm) ÷ 2. Reported as winner 0 cm, others +Ncm.
      </div>

      {/* Fleet ranking — primary view */}
      {results.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline",
            marginBottom:6 }}>
            <Lbl style={{ marginBottom:0 }}>Fleet Ranking</Lbl>
            <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
              {completedCount}/{totalPairs > 0 ? totalPairs : "?"} pair{completedCount!==1?"s":""} complete
            </span>
          </div>
          <div style={{ background:"var(--paper-2)", borderRadius:8, overflow:"hidden",
            border:"1.5px solid var(--rule)" }}>
            {results.map((r, i) => (
              <div key={r.skiId} style={{ display:"flex", justifyContent:"space-between",
                alignItems:"center", padding:"10px 14px",
                borderBottom: i < results.length-1 ? "1px solid var(--rule)" : "none",
                background: i === 0 ? "var(--paper-3)" : "transparent" }}>
                <div>
                  <span className="mono" style={{ fontSize:12, color:"var(--ink-faint)",
                    marginRight:8, fontWeight:600 }}>#{i+1}</span>
                  <span className="mono" style={{ fontWeight:700, fontSize:14 }}>{r.skiId}</span>
                  {!isBlind && r.product && (
                    <span style={{ fontSize:13, color:"var(--ink-mid)", marginLeft:8 }}>{r.product}</span>
                  )}
                  {!isBlind && r.application && (
                    <div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:1,
                      paddingLeft:20 }}>{r.application}</div>
                  )}
                </div>
                <div style={{ textAlign:"right" }}>
                  <span className="mono" style={{ fontSize:16, fontWeight:700,
                    color: i === 0 ? "var(--green)" : "var(--ink-mid)" }}>
                    {i === 0 ? "0 cm" : `+${r.cmGap.toFixed(1)} cm`}
                  </span>
                  <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)" }}>
                    {r.compCount} comp{r.compCount!==1?"s":""}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Declare winner */}
          {completedCount >= 1 && !hasWinner && (
            <button className="btn" style={{ width:"100%", marginTop:8, fontSize:13 }}
              onClick={() => onUpdate({ ...test,
                skis: (test.skis||[]).map(s => ({
                  ...s,
                  standing: s.id === results[0].skiId ? "Winner" : "Eliminated"
                }))
              })}>
              Declare {results[0].skiId} Winner
            </button>
          )}
        </div>
      )}

      {/* Add comparison */}
      {!hasWinner && (
        <div style={{ background:"var(--paper-2)", borderRadius:8, padding:14,
          marginBottom:16, border:"1.5px solid var(--rule)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline",
            marginBottom:8 }}>
            <Lbl style={{ marginBottom:0 }}>New Comparison</Lbl>
            {suggested && (
              <span style={{ fontSize:11, color:"var(--blue)" }}>
                Suggested: {suggested.skiA} vs {suggested.skiB}
                {suggested.timesRun > 0 ? ` (run ${suggested.timesRun}×)` : ""}
              </span>
            )}
          </div>
          {activeSkis.length < 2 ? (
            <div style={{ fontSize:13, color:"var(--ink-faint)" }}>
              Add at least 2 skis in the Fleet tab to begin.
            </div>
          ) : (
            <>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
                <div>
                  <Lbl>Ski A (leads first)</Lbl>
                  <select className="inp" value={skiA} onChange={e => setSkiA(e.target.value)}>
                    <option value="">— select —</option>
                    {activeSkis.filter(s => s.id !== skiB).map(s => (
                      <option key={s.id} value={s.id}>
                        {s.id}{!isBlind && s.product ? ` — ${s.product}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Lbl>Ski B (leads after swap)</Lbl>
                  <select className="inp" value={skiB} onChange={e => setSkiB(e.target.value)}>
                    <option value="">— select —</option>
                    {activeSkis.filter(s => s.id !== skiA).map(s => (
                      <option key={s.id} value={s.id}>
                        {s.id}{!isBlind && s.product ? ` — ${s.product}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <TI label="Tester(s)" value={testers} onChange={setTesters}
                placeholder="Names or initials of the two skiers"
                style={{ marginBottom:8 }} />
              <button className="btn" onClick={addComparison}
                disabled={!skiA || !skiB || skiA === skiB}
                style={{ width:"100%", fontSize:14 }}>
                + Add Comparison
              </button>
            </>
          )}
        </div>
      )}

      {/* Comparison cards — most recent first */}
      {comparisons.length === 0 && (
        <div style={{ color:"var(--ink-faint)", fontSize:13, textAlign:"center", padding:"20px 0" }}>
          No comparisons yet. Select two skis and tap + Add Comparison.
        </div>
      )}
      {[...comparisons].reverse().map(comp => (
        <GlideOutComparisonCard key={comp.id} comp={comp} skis={test.skis} isBlind={isBlind}
          onUpdate={patch => updateComp(comp.id, patch)}
          onDelete={() => deleteComp(comp.id)} />
      ))}
    </div>
  );
}


// ─── UNDO TOAST ───────────────────────────────────────────────────────────────
function UndoToast({ message, onUndo, onDismiss }) {
  useEffect(()=>{ const t=setTimeout(onDismiss,5000); return ()=>clearTimeout(t); },[]);
  return <div className="undo-toast no-print">
    <span>{message}</span>
    <button onClick={onUndo} style={{ background:"none", border:"1.5px solid rgba(255,255,255,0.4)",
      color:"#fff", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:600 }}>Undo</button>
    <button onClick={onDismiss} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.6)",
      cursor:"pointer", fontSize:18, lineHeight:1 }}>×</button>
  </div>;
}

// ─── COMPOSITE COLOR & BADGE ──────────────────────────────────────────────────
function compositeColor(score, max) {
  const p = score/max;
  return p>=0.75 ? "var(--green)" : p>=0.45 ? "var(--amber)" : "var(--red)";
}
function RatingBadge({ score, max, label }) {
  if (score==null) return null;
  return <span style={{ display:"inline-flex", alignItems:"center", fontFamily:"'SF Mono','Courier New',monospace",
    fontWeight:700, fontSize:14, padding:"5px 12px", background:compositeColor(score,max),
    color:"#fff", borderRadius:6, minHeight:32, letterSpacing:"0.03em" }}>
    {label?`${label} `:""}{score}/{max}
  </span>;
}

// ─── SWIPE CARD ───────────────────────────────────────────────────────────────
function SwipeCard({ onSwipeLeft, onSwipeRight, children, style }) {
  const ref = useRef(null);
  const startX = useRef(null);
  const dx = useRef(0);
  function onTouchStart(e) { startX.current=e.touches[0].clientX; dx.current=0; }
  function onTouchMove(e) {
    if (startX.current==null) return;
    dx.current=e.touches[0].clientX-startX.current;
    if (ref.current) {
      ref.current.classList.add("swiping");
      ref.current.style.transform=`translateX(${dx.current*0.4}px)`;
      ref.current.style.opacity=Math.max(0.5,1-Math.abs(dx.current)/200);
    }
  }
  function onTouchEnd() {
    if (ref.current) { ref.current.classList.remove("swiping"); ref.current.style.transform=""; ref.current.style.opacity=""; }
    if (dx.current>60&&onSwipeRight) onSwipeRight();
    else if (dx.current<-60&&onSwipeLeft) onSwipeLeft();
    startX.current=null;
  }
  return <div ref={ref} className="swipe-card" style={style}
    onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
    {children}
  </div>;
}

// ─── SNOW TEMP FAB + MODAL ────────────────────────────────────────────────────
// Generalised temp FAB — used for both snow and air temp logging.
// label: display name, icon: emoji, fabClass: CSS class for positioning
function TempFAB({ readings=[], onAdd, onDelete, useCelsius, onUnitToggle,
                   label="Snow Temp", icon="❄", fabClass="snow-fab" }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef(null);

  function submit() {
    const stored = storeTemp(val, useCelsius);
    if (stored==null) return;
    onAdd({ ts:nowStr(), tempF:stored });
    setVal(""); inputRef.current?.focus();
  }
  const last = readings.length ? readings[readings.length-1] : null;

  return <>
    <button className={`${fabClass} no-print`}
      onClick={()=>{ setOpen(true); setTimeout(()=>inputRef.current?.focus(),100); }}>
      {icon} {last ? dispTemp(last.tempF, useCelsius) : label}
    </button>
    {open && <div className="snow-modal-backdrop" onClick={e=>{ if(e.target===e.currentTarget) setOpen(false); }}>
      <div className="snow-modal">
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <span style={{ fontSize:17, fontWeight:700 }}>{label}</span>
          <button onClick={()=>setOpen(false)} className="btn-text" style={{ fontSize:22 }}>×</button>
        </div>
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          <input ref={inputRef} className="inp" type="number" inputMode="decimal"
            value={val} placeholder={useCelsius?"e.g. -5":"e.g. 23"}
            onChange={e=>setVal(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&submit()}
            style={{ flex:1, fontSize:22, fontWeight:700, textAlign:"center" }} />
          <button className="btn" onClick={submit} style={{ padding:"0 20px" }}>Log</button>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <Lbl>Readings</Lbl>
          <UnitPill useCelsius={useCelsius} onChange={onUnitToggle||((v)=>{})} />
        </div>
        {readings.length===0
          ? <div style={{ color:"var(--ink-faint)", fontSize:13, padding:"8px 0" }}>No readings yet.</div>
          : [...readings].sort((a,b)=>new Date(b.ts)-new Date(a.ts)).map((r,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                padding:"8px 0", borderTop:"1px solid var(--rule)" }}>
                <span style={{ fontSize:16, fontWeight:600 }}>{dispTemp(r.tempF, useCelsius)}</span>
                <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>{fmtTime(r.ts)}</span>
                {onDelete && <button onClick={()=>onDelete(i)} className="btn-text" style={{ padding:"4px 8px" }}>×</button>}
              </div>
            ))
        }
      </div>
    </div>}
  </>;
}

// Backwards-compatible aliases
function SnowTempFAB(props) {
  return <TempFAB {...props} label="Snow Temperature" icon="❄" fabClass="snow-fab" />;
}
function AirTempFAB(props) {
  return <TempFAB {...props} label="Air Temperature" icon="🌡" fabClass="air-fab" />;
}

// ─── WEATHER PANEL ────────────────────────────────────────────────────────────
function WeatherPanel({ weather={}, onChange, vocab, onVocabAdd, useCelsius, onUnitToggle, onPromoteWeather }) {
  const [place, setPlace] = useState("");
  const [fetching, setFetching] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [geoResults, setGeoResults] = useState([]);
  const w = weather;
  function up(field, val) { onChange({ ...w, [field]:val }); }

  async function doGPS() {
    if (!navigator.geolocation) { setErr("GPS not available"); return; }
    setFetching(true); setErr(null); setMsg("Getting location…");
    try {
      const pos = await new Promise((res,rej) => {
        const t = setTimeout(()=>rej(new Error("GPS timed out")),10000);
        navigator.geolocation.getCurrentPosition(
          p=>{ clearTimeout(t); res(p); },
          e=>{ clearTimeout(t); rej(new Error(e.code===1?"Location access denied":"GPS unavailable")); },
          { timeout:9000, maximumAge:60000 }
        );
      });
      setMsg("Fetching weather…");
      const { latitude:lat, longitude:lon } = pos.coords;
      const [wx, loc] = await Promise.all([fetchWeather(lat,lon), reverseGeocode(lat,lon)]);
      onChange({ ...w, ...wx, location:loc||w.location });
      setMsg(`✓ Updated${loc?` — ${loc}`:""}`);
    } catch(e) { setErr(e.message); setMsg(null); }
    setFetching(false);
  }
  async function doPlace() {
    if (!place.trim()) return;
    setFetching(true); setErr(null); setMsg("Searching…"); setGeoResults([]);
    try {
      const results = await geocodePlaceMulti(place);
      if (results.length === 1) {
        // Only one result — load immediately
        setMsg(`Fetching weather for ${results[0].label}…`);
        const wx = await fetchWeather(results[0].lat, results[0].lon);
        onChange({ ...w, ...wx, location: results[0].label });
        setMsg(`✓ Updated — ${results[0].label}`);
      } else {
        // Multiple results — show picker
        setGeoResults(results);
        setMsg(null);
      }
    } catch(e) { setErr(e.message); setMsg(null); }
    setFetching(false);
  }

  async function pickGeoResult(geo) {
    setGeoResults([]); setFetching(true); setMsg(`Fetching weather for ${geo.label}…`);
    try {
      const wx = await fetchWeather(geo.lat, geo.lon);
      onChange({ ...w, ...wx, location: geo.label });
      setMsg(`✓ Updated — ${geo.label}`);
    } catch(e) { setErr(e.message); setMsg(null); }
    setFetching(false);
  }

  // Display air temp in selected unit (stored in F)
  const airDisplay = w.airTempF!=null ? (useCelsius ? fToC(w.airTempF) : w.airTempF) : "";
  function setAirTemp(v) {
    const stored = storeTemp(v, useCelsius);
    up("airTempF", stored);
  }

  return <div>
    {/* GPS primary, search secondary */}
    <button className="btn" onClick={doGPS} disabled={fetching}
      style={{ width:"100%", marginBottom:8, fontSize:14 }}>
      {fetching?"Fetching location…":"Use GPS"}
    </button>
    <div style={{ display:"flex", gap:8, marginBottom:12 }}>
      <input className="inp" placeholder="Or search venue / city…" value={place}
        onChange={e=>setPlace(e.target.value)}
        onKeyDown={e=>e.key==="Enter"&&doPlace()} style={{ flex:1 }} />
      <button className="btn-ghost" onClick={doPlace} disabled={fetching}>Search</button>
    </div>
    {/* Multiple results picker */}
    {geoResults.length > 1 && (
      <div style={{ marginBottom:12 }}>
        <Lbl>Select location</Lbl>
        {geoResults.map((geo, i) => (
          <button key={i} onClick={() => pickGeoResult(geo)}
            className="btn-ghost"
            style={{ width:"100%", textAlign:"left", marginBottom:4, fontSize:13,
              padding:"8px 12px", minHeight:36 }}>
            {geo.label}
          </button>
        ))}
        <button onClick={() => setGeoResults([])} className="btn-text"
          style={{ fontSize:12, padding:"4px 0" }}>Cancel</button>
      </div>
    )}
    {msg && <div style={{ fontSize:13, color:"var(--green)", marginBottom:8, fontWeight:500 }}>{msg}</div>}
    {err && <div style={{ fontSize:13, color:"var(--red)", marginBottom:8 }}>{err}</div>}

    <Hr />
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
      <Lbl style={{ marginBottom:0 }}>Conditions</Lbl>
      <UnitPill useCelsius={useCelsius} onChange={onUnitToggle} />
    </div>

    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
      <div>
        <Lbl>Air Temp ({useCelsius?"°C":"°F"})</Lbl>
        <input className="inp" type="number" inputMode="numeric" value={airDisplay}
          onChange={e=>setAirTemp(e.target.value)} />
      </div>
      <div>
        <Lbl>Humidity %</Lbl>
        <input className="inp" type="number" inputMode="numeric" value={w.humidity??""} 
          onChange={e=>up("humidity",e.target.value===""?null:Number(e.target.value))} />
      </div>
      <div>
        <Lbl>Wind mph</Lbl>
        <input className="inp" type="number" inputMode="numeric" value={w.windMph??""} 
          onChange={e=>up("windMph",e.target.value===""?null:Number(e.target.value))} />
      </div>
      <div>
        <Lbl>Snow Depth cm</Lbl>
        <input className="inp" type="number" inputMode="numeric" value={w.snowDepthCm??""} 
          onChange={e=>up("snowDepthCm",e.target.value===""?null:Number(e.target.value))} />
      </div>
    </div>

    <SI label="Sky" value={w.sky} onChange={v=>up("sky",v)} style={{ marginBottom:8 }}
      options={["Clear","Mostly Clear","Partly Cloudy","Overcast","Foggy","Snowing","Blowing Snow"]} />
    <SI label="Snow Type" value={w.snowType} onChange={v=>up("snowType",v)} style={{ marginBottom:8 }}
      options={["Dry powder","Dry packed","Wet packed","Wet","Transformed","Granular","Variable"]} />
    <ACI label="Grooming / Snow Age" value={w.grooming||""} onChange={v=>up("grooming",v)}
      onCommit={v=>onVocabAdd?.("grooming",[v])} suggestions={vocab?.grooming||[]}
      placeholder="e.g. 1-day-old machine groomed" />
    <TA label="Course Notes" value={w.trailNotes} onChange={v=>up("trailNotes",v)} rows={2} />
    {onPromoteWeather && w.airTempF!=null && (
      <button className="btn-ghost" onClick={onPromoteWeather}
        style={{ width:"100%", fontSize:12, marginTop:8, padding:"8px 0", color:"var(--ink-mid)" }}>
        Use as event-level weather
      </button>
    )}
  </div>;
}


// ─── INLINE PREDICT PANEL ─────────────────────────────────────────────────────
// Shown at the bottom of the Conditions tab in SessionView.
// Pre-fills air temp + snow type from current session weather automatically.
function PredictPanel({ allEvents, sessionWeather, useCelsius }) {
  const w = sessionWeather || {};
  const [open, setOpen]     = useState(false);
  const [airInput, setAir]  = useState("");
  const [snowInput, setSnow]= useState("");
  const [snowType, setSnowType] = useState(w.snowType||"");
  const [results, setResults]   = useState(null);

  // Pre-fill from session weather when panel is opened
  function handleOpen() {
    if (!open) {
      if (w.airTempF  != null) setAir(String(Math.round(useCelsius ? (w.airTempF-32)*5/9 : w.airTempF)));
      if (w.snowType)          setSnowType(w.snowType);
      setResults(null);
    }
    setOpen(o => !o);
  }

  function predict() {
    const airF  = storeTemp(airInput,  useCelsius);
    const snowF = storeTemp(snowInput, useCelsius);
    const candidates = [];
    (allEvents||[]).forEach(ev => {
      (ev.sessions||[]).forEach(sess => {
        (sess.tests||[]).forEach(test => {
          const evAir  = ev.weather?.airTempF;
          const evSnow = (sess.snowTemps||[]).slice(-1)[0]?.tempF
                      ?? (sess.tests||[]).flatMap(t=>t.snowTemps||[]).slice(-1)[0]?.tempF;
          let baseScore = 0;
          if (airF  != null && evAir  != null) baseScore += Math.max(0, 10 - Math.abs(airF  - evAir));
          if (snowF != null && evSnow != null) baseScore += Math.max(0, 10 - Math.abs(snowF - evSnow));
          if (snowType && (ev.weather?.snowType===snowType || sess.weather?.snowType===snowType)) baseScore += 5;
          const isG = test.category === "glide" || test.category === "glide-out";
          // Include Winners (full weight) and Runner-Ups (60% weight)
          (test.skis||[]).filter(s => s.standing==="Winner"||s.standing==="Runner-Up").forEach(ski => {
            if (!ski.product) return;
            const placeMult = ski.standing==="Winner" ? 1.0 : 0.6;
            const comp = isG ? ski.ratings?.glide
              : (ski.ratings?.kick!=null&&ski.ratings?.glide!=null ? ski.ratings.kick+ski.ratings.glide : null);
            candidates.push({ product:ski.product, application:ski.application||"",
              category:test.category, score:baseScore*placeMult, comp, max:isG?10:20,
              standing:ski.standing, eventName:ev.name, airF:evAir, snowF:evSnow });
          });
        });
      });
    });
    candidates.sort((a,b) => b.score-a.score || (b.comp??0)/b.max-(a.comp??0)/a.max);
    setResults(candidates.slice(0, 8));
  }

  const hasHistory = (allEvents||[]).some(ev =>
    (ev.sessions||[]).some(s => (s.tests||[]).some(t => t.skis?.some(sk => sk.standing==="Winner")))
  );

  if (!hasHistory) return null;  // nothing to predict from — hide silently

  return (
    <div style={{ marginTop:16 }}>
      <button onClick={handleOpen} className="btn-ghost"
        style={{ width:"100%", fontSize:13, padding:"10px 0", fontWeight:600 }}>
        {open ? "▲ Hide Wax Suggestions" : "Suggest Wax from History"}
      </button>

      {open && (
        <div style={{ marginTop:12, padding:"14px", background:"var(--paper-2)",
          borderRadius:8, border:"1.5px solid var(--rule)" }}>
          <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:10, lineHeight:1.5 }}>
            Searches past winners across all events for similar conditions.
            Current conditions are pre-filled where available.
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
            <NI label={`Air Temp (${useCelsius?"°C":"°F"})`} value={airInput}
              onChange={setAir} style={{ marginBottom:0 }} />
            <NI label={`Snow Temp (${useCelsius?"°C":"°F"})`} value={snowInput}
              onChange={setSnow} style={{ marginBottom:0 }} />
          </div>
          <SI label="Snow Type" value={snowType} onChange={setSnowType} style={{ marginBottom:8 }}
            options={["Dry powder","Dry packed","Wet packed","Wet","Transformed","Granular","Variable"]} />
          <button className="btn" onClick={predict}
            style={{ width:"100%", fontSize:13 }}>Find Best Matches</button>

          {results && (
            <div style={{ marginTop:12 }}>
              {results.length === 0
                ? <div style={{ color:"var(--ink-faint)", fontSize:13, padding:"8px 0" }}>
                    No matching past results found.
                  </div>
                : results.map((r, i) => (
                    <div key={i} style={{ padding:"10px 12px", background:"var(--paper)",
                      borderRadius:6, marginBottom:6, border:"1px solid var(--rule)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:700, fontSize:14 }}>{r.product}</div>
                          {r.application&&<div style={{ fontSize:12, color:"var(--ink-mid)",marginTop:1 }}>{r.application}</div>}
                          <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:3 }}>
                            {r.category} · {r.eventName}
                            {r.standing==="Runner-Up"?" · 2nd place":""}
                            {r.airF!=null?` · air ${dispTemp(r.airF,useCelsius)}`:""}
                            {r.snowF!=null?` · snow ${dispTemp(r.snowF,useCelsius)}`:""}
                          </div>
                        </div>
                        {r.comp!=null&&<RatingBadge score={r.comp} max={r.max} />}
                      </div>
                    </div>
                  ))
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CONDITIONS TREND ─────────────────────────────────────────────────────────
function ConditionsTrend({ events, useCelsius }) {
  const points = [];
  (events||[]).forEach(ev=>{
    (ev.sessions||[]).forEach(sess=>{
      const w = ev.weather;
      const snowF = sess.snowTemps?.length ? sess.snowTemps[sess.snowTemps.length-1].tempF : null;
      if (!w?.airTempF && snowF==null) return;
      points.push({ label:`${fmtDate(ev.date||ev.createdAt)} – ${sess.name}`,
        airF:w?.airTempF??null, snowF, eventName:ev.name });
    });
  });
  if (points.length<2) return <div style={{ color:"var(--ink-faint)", fontSize:13, padding:"12px 0" }}>
    Need 2+ sessions with conditions data to show trend.</div>;

  const allV=[...points.map(p=>p.airF),...points.map(p=>p.snowF)].filter(v=>v!=null);
  const minV=Math.min(...allV)-5, maxV=Math.max(...allV)+5, range=maxV-minV||1;
  function barH(v) { return v==null?0:Math.max(4,Math.round(((v-minV)/range)*50)); }
  function tip(p,field) {
    const f=field==="airF"?p.airF:p.snowF;
    return f!=null?`${dispTemp(f,useCelsius)} – ${p.label}`:"No data";
  }
  return <div>
    <Lbl>Air Temperature</Lbl>
    <div className="trend-wrap" style={{ marginBottom:4 }}>
      {points.map((p,i)=><div key={i} className="trend-bar"
        style={{ height:barH(p.airF), background:p.airF!=null?"var(--blue)":"var(--paper-3)" }}
        data-tip={tip(p,"airF")} />)}
    </div>
    <div style={{ display:"flex", gap:3, marginBottom:16 }}>
      {points.map((p,i)=><div key={i} style={{ flex:1, fontSize:9, color:"var(--ink-faint)",
        textAlign:"center", overflow:"hidden" }} className="mono">
        {p.airF!=null?dispTemp(p.airF,useCelsius):"–"}</div>)}
    </div>
    {points.some(p=>p.snowF!=null) && <>
      <Lbl>Snow Temperature</Lbl>
      <div className="trend-wrap" style={{ marginBottom:4 }}>
        {points.map((p,i)=><div key={i} className="trend-bar"
          style={{ height:barH(p.snowF), background:p.snowF!=null?"var(--ink-faint)":"var(--paper-3)" }}
          data-tip={tip(p,"snowF")} />)}
      </div>
      <div style={{ display:"flex", gap:3 }}>
        {points.map((p,i)=><div key={i} style={{ flex:1, fontSize:9, color:"var(--ink-faint)",
          textAlign:"center" }} className="mono">
          {p.snowF!=null?dispTemp(p.snowF,useCelsius):"–"}</div>)}
      </div>
    </>}
  </div>;
}

// ─── CROSS-EVENT COMPARE ──────────────────────────────────────────────────────
function CrossEventComparison({ events, useCelsius }) {
  const [filter, setFilter] = useState("all");
  const results = [];
  (events||[]).forEach(ev=>{
    (ev.sessions||[]).forEach(sess=>{
      (sess.tests||[]).forEach(test=>{
        (test.skis||[]).forEach(ski=>{
          if (!ski.product) return;
          const isGlide = test.category==="glide"||test.category==="glide-out";
          const comp = isGlide?ski.ratings?.glide
            :(ski.ratings?.kick!=null&&ski.ratings?.glide!=null?ski.ratings.kick+ski.ratings.glide:null);
          const snowF = (test.snowTemps||[]).slice(-1)[0]?.tempF;
          const airF2 = (test.airTemps||[]).slice(-1)[0]?.tempF;
          results.push({ product:ski.product, application:ski.application,
            category:test.category, isWinner:ski.standing==="Winner",
            comp, max:isGlide?10:20, eventName:ev.name,
            eventDate:ev.date||ev.createdAt, location:ev.location,
            airF:ev.weather?.airTempF, snowF });
        });
      });
    });
  });
  const byProduct = {};
  results.forEach(r=>{ if(!byProduct[r.product]) byProduct[r.product]=[]; byProduct[r.product].push(r); });
  const products = Object.keys(byProduct).sort((a,b)=>byProduct[b].filter(r=>r.isWinner).length-byProduct[a].filter(r=>r.isWinner).length);
  const filtered = filter==="all"?products:filter==="winners"?products.filter(p=>byProduct[p].some(r=>r.isWinner)):products.filter(p=>byProduct[p].some(r=>r.category===filter));

  if (results.length===0) return <div style={{ color:"var(--ink-faint)", fontSize:13, padding:"12px 0" }}>No results yet.</div>;

  return <div>
    <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
      {["all","winners","glide","kick"].map(f=>(
        <button key={f} onClick={()=>setFilter(f)}
          className={filter===f?"btn":"btn-ghost"}
          style={{ fontSize:12, padding:"8px 14px", minHeight:36 }}>
          {f.charAt(0).toUpperCase()+f.slice(1)}
        </button>
      ))}
    </div>
    {filtered.map(product=>{
      const rows=byProduct[product];
      const wins=rows.filter(r=>r.isWinner).length;
      const rated=rows.filter(r=>r.comp!=null);
      const avg=rated.length?Math.round(rated.reduce((s,r)=>s+r.comp,0)/rated.length*10)/10:null;
      return <div key={product} style={{ marginBottom:24 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
          <span style={{ fontWeight:700, fontSize:15 }}>{product}</span>
          <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
            {wins} win{wins!==1?"s":""}{avg!=null?` · avg ${avg}`:""} · {rows.length} result{rows.length!==1?"s":""}
          </span>
        </div>
        <table className="cmp-table">
          <thead><tr><th>Date</th><th>Location</th><th>Cat</th><th>Application</th><th>Score</th><th>Air</th><th>Snow</th><th></th></tr></thead>
          <tbody>
            {rows.sort((a,b)=>new Date(b.eventDate)-new Date(a.eventDate)).map((r,i)=>(
              <tr key={i}>
                <td className="mono" style={{ fontSize:11 }}>{fmtDate(r.eventDate)}</td>
                <td style={{ fontSize:12 }}>{r.location||r.eventName||"—"}</td>
                <td className="mono" style={{ fontSize:11 }}>{r.category}</td>
                <td style={{ fontSize:12 }}>{r.application||"—"}</td>
                <td>{r.comp!=null?<RatingBadge score={r.comp} max={r.max} />:"—"}</td>
                <td className="mono" style={{ fontSize:11 }}>{r.airF!=null?dispTemp(r.airF,useCelsius):"—"}</td>
                <td className="mono" style={{ fontSize:11 }}>{r.snowF!=null?dispTemp(r.snowF,useCelsius):"—"}</td>
                <td>{r.isWinner?<span className="tag" style={{ color:"var(--green)", fontSize:9 }}>Win</span>:""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Hr />
      </div>;
    })}
  </div>;
}

// ─── RACE DAY SUMMARY ─────────────────────────────────────────────────────────
function RaceDaySummary({ event, useCelsius }) {
  // Aggregate session-level weather as fallback for event-level weather
  const sessWeathers = (event.sessions||[]).map(s=>s.weather||{}).filter(sw=>sw.airTempF!=null||sw.snowType);
  const bestSessW = sessWeathers[0] || {};
  const rawW = event.weather||{};
  const w = {
    airTempF:    rawW.airTempF    ?? bestSessW.airTempF,
    sky:         rawW.sky         ?? bestSessW.sky,
    windMph:     rawW.windMph     ?? bestSessW.windMph,
    humidity:    rawW.humidity    ?? bestSessW.humidity,
    snowDepthCm: rawW.snowDepthCm ?? bestSessW.snowDepthCm,
    snowType:    rawW.snowType    ?? bestSessW.snowType,
    grooming:    rawW.grooming    ?? bestSessW.grooming,
    trailNotes:  rawW.trailNotes  ?? bestSessW.trailNotes,
  };
  const allWinners=[], runners=[];
  (event.sessions||[]).forEach(sess=>{
    (sess.tests||[]).forEach(test=>{
      const winner=test.skis?.find(s=>s.standing==="Winner");
      if (winner) {
        const isG=test.category==="glide"||test.category==="glide-out";
        const comp=isG?winner.ratings?.glide:(winner.ratings?.kick!=null&&winner.ratings?.glide!=null?winner.ratings.kick+winner.ratings.glide:null);
        allWinners.push({ski:winner,test,sess,isG,comp,max:isG?10:20});
      }
      (test.skis||[]).filter(s=>(s.standing==="Eliminated"||s.standing==="Runner-Up")&&s.ratings).forEach(ski=>{
        const isG=test.category==="glide"||test.category==="glide-out";
        const comp=isG?ski.ratings?.glide:(ski.ratings?.kick!=null&&ski.ratings?.glide!=null?ski.ratings.kick+ski.ratings.glide:null);
        if (comp!=null) runners.push({ski,test,sess,isG,comp,max:isG?10:20,isRunnerUp:ski.standing==="Runner-Up"});
      });
    });
  });
  const topRunners=[...runners].sort((a,b)=>{
    // Runner-Up always comes first, then by composite score
    if (a.isRunnerUp && !b.isRunnerUp) return -1;
    if (!a.isRunnerUp && b.isRunnerUp) return 1;
    return b.comp/b.max - a.comp/a.max;
  }).slice(0,6);
  const lastSnow=(event.sessions||[]).flatMap(s=>(s.tests||[]).flatMap(t=>t.snowTemps||[])).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
  const lastAir =(event.sessions||[]).flatMap(s=>(s.tests||[]).flatMap(t=>t.airTemps||[])).sort((a,b)=>new Date(b.ts)-new Date(a.ts))[0];
  const condItems=[
    ["Air Temp", w.airTempF!=null ? dispTemp(w.airTempF,useCelsius)
               : lastAir ? `${dispTemp(lastAir.tempF,useCelsius)} (logged)` : null],
    ["Sky",      w.sky],
    ["Wind",     w.windMph!=null ? `${w.windMph} mph` : null],
    ["Humidity", w.humidity!=null ? `${w.humidity}%` : null],
    ["Snow Temp",lastSnow ? `${dispTemp(lastSnow.tempF,useCelsius)} (logged ${fmtTime(lastSnow.ts)})` : null],
    ["Snow Depth",w.snowDepthCm!=null ? `${w.snowDepthCm} cm` : null],
    ["Snow Type",w.snowType],
    ["Grooming", w.grooming],
  ].filter(([,v])=>v);

  return <div className="race-day-summary" style={{ paddingBottom:24 }}>
    <div style={{ marginBottom:16 }} className="no-print">
      <button onClick={()=>window.print()} className="btn-ghost" style={{ fontSize:13 }}>Print / Save PDF</button>
    </div>
    <div className="print-only" style={{ fontSize:11, fontWeight:600, letterSpacing:"0.1em",
      textTransform:"uppercase", marginBottom:8, color:"#666" }}>WaxLab Race Day Summary</div>
    <div style={{ fontSize:24, fontWeight:800, marginBottom:2 }}>{event.name}</div>
    {event.raceName&&<div style={{ fontSize:16, color:"var(--ink-mid)", marginBottom:2 }}>{event.raceName}</div>}
    {event.location&&<div className="mono" style={{ fontSize:13, color:"var(--ink-faint)", marginBottom:4 }}>{event.location}</div>}
    <div className="mono" style={{ fontSize:12, color:"var(--ink-faint)" }}>{fmtDate(event.date||event.createdAt)}</div>

    <Hr />
    {condItems.length>0&&<>
      <Lbl>Conditions</Lbl>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
        {condItems.map(([k,v])=>(
          <div key={k} style={{ background:"var(--paper-2)", borderRadius:6, padding:"8px 10px" }}>
            <div className="mono" style={{ fontSize:9, color:"var(--ink-faint)", textTransform:"uppercase",
              letterSpacing:"0.08em", marginBottom:2 }}>{k}</div>
            <div style={{ fontSize:13, fontWeight:600 }}>{v}</div>
          </div>
        ))}
      </div>
      {w.trailNotes&&<div style={{ fontSize:13, color:"var(--ink-mid)", fontStyle:"italic", marginBottom:16 }}>{w.trailNotes}</div>}
    </>}

    {(event.raceWaxChoice||event.raceWaxReason)&&<>
      <Hr />
      <Lbl>Race Wax Selection</Lbl>
      <div style={{ background:"var(--paper-2)", borderRadius:8, padding:"14px 16px", marginBottom:8 }}>
        {event.raceWaxChoice&&(
          <div style={{ fontWeight:700, fontSize:17, marginBottom: event.raceWaxReason ? 6 : 0 }}>
            {event.raceWaxChoice}
          </div>
        )}
        {event.raceWaxReason&&(
          <div style={{ fontSize:13, color:"var(--ink-mid)", lineHeight:1.6 }}>
            {event.raceWaxReason}
          </div>
        )}
      </div>
    </>}

    {allWinners.length>0&&<>
      <Lbl>Test Winners</Lbl>
      {allWinners.map(({ski,test,sess,isG,comp,max},i)=>(
        <div key={i} className="card" style={{ padding:"12px 14px", marginBottom:8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ fontWeight:700, fontSize:15 }}>{ski.product||ski.id}</div>
              {ski.application&&<div style={{ fontSize:13, color:"var(--ink-mid)" }}>{ski.application}</div>}
              <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:2 }}>
                {sess.name} · {test.category} {test.type}
                {test.testers ? ` · ${test.testers}` : ""}
              </div>
            </div>
            {comp!=null&&<RatingBadge score={comp} max={max} />}
          </div>
          {ski.feelNotes&&<div style={{ fontSize:12, color:"var(--ink-mid)", marginTop:6, fontStyle:"italic" }}>{ski.feelNotes}</div>}
          {ski.photos?.length>0&&<div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
            {ski.photos.slice(0,4).map(p=>(
              <img key={p.id} src={p.thumb} alt={p.caption||""}
                style={{ width:52, height:52, objectFit:"cover", borderRadius:4 }} />
            ))}
          </div>}
        </div>
      ))}
    </>}

    {topRunners.length>0&&<>
      <Hr />
      <Lbl>Runners-Up</Lbl>
      {topRunners.map(({ski,comp,max},i)=>(
        <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"8px 0", borderBottom:"1px solid var(--rule)" }}>
          <div>
            <span style={{ fontSize:13 }}>{ski.product||ski.id}{ski.application?` — ${ski.application}`:""}</span>
            {isRunnerUp&&<span style={{ marginLeft:8, fontSize:10, fontWeight:700, color:"var(--amber)",
              letterSpacing:"0.06em" }}>2ND</span>}
          </div>
          {comp!=null&&<RatingBadge score={comp} max={max} />}
        </div>
      ))}
    </>}

    {event.notes&&<><Hr /><Lbl>Notes</Lbl><div style={{ fontSize:14, lineHeight:1.6 }}>{event.notes}</div></>}
    {event.raceFeedback&&<>
      <Hr />
      <div style={{ fontSize:12, color:"var(--ink-faint)", fontStyle:"italic",
        paddingTop:4, lineHeight:1.6 }}>
        {event.raceFeedback}
      </div>
    </>}
  </div>;
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function buildSheets(event) {
  const w=event.weather||{};
  const info=[["Event",event.name||""],["Race",event.raceName||""],["Location",event.location||""],["Date",fmtDate(event.date||event.createdAt)],["Notes",event.notes||""],["Race Wax Selected",event.raceWaxChoice||""],["Selection Reason",event.raceWaxReason||""],["Post-race Feedback",event.raceFeedback||""]];
  // Merge event weather with richest session weather for export
  const sessWeathers = (event.sessions||[]).map(s=>s.weather||{}).filter(sw=>sw.airTempF!=null||sw.snowType);
  const bestSessW = sessWeathers[0] || {};
  const effW = {
    airTempF:   w.airTempF   ?? bestSessW.airTempF,
    humidity:   w.humidity   ?? bestSessW.humidity,
    windMph:    w.windMph    ?? bestSessW.windMph,
    sky:        w.sky        ?? bestSessW.sky,
    snowType:   w.snowType   ?? bestSessW.snowType,
    snowDepthCm:w.snowDepthCm?? bestSessW.snowDepthCm,
    grooming:   w.grooming   ?? bestSessW.grooming,
    trailNotes: w.trailNotes ?? bestSessW.trailNotes,
  };
  const cond=[["Air Temp (F)",effW.airTempF],["Humidity %",effW.humidity],["Wind mph",effW.windMph],["Sky",effW.sky],["Snow Type",effW.snowType],["Snow Depth cm",effW.snowDepthCm],["Grooming",effW.grooming],["Course Notes",effW.trailNotes]];
  const log=[["Session","Test","Tester(s)","Category","Type","Ski ID","Product","Application","Notes","Kick","Glide","Composite","Standing","Feel Notes"]];
  const snow=[["Session","Test","Timestamp","Type","Temp F","Temp C"]];
  (event.sessions||[]).forEach(sess=>{
    (sess.snowTemps||[]).forEach(r=>snow.push([sess.name,"(session)",fmtDateTime(r.ts),"Snow",r.tempF,Math.round((r.tempF-32)*5/9*10)/10]));
    (sess.tests||[]).forEach(test=>{
      (test.snowTemps||[]).forEach(r=>snow.push([sess.name,test.name||"",fmtDateTime(r.ts),"Snow",r.tempF,Math.round((r.tempF-32)*5/9*10)/10]));
      (test.airTemps||[]).forEach(r=>snow.push([sess.name,test.name||"",fmtDateTime(r.ts),"Air",r.tempF,Math.round((r.tempF-32)*5/9*10)/10]));
      (test.skis||[]).forEach(ski=>{
        const isG=test.category==="glide"||test.category==="glide-out";
        const comp=isG?ski.ratings?.glide:(ski.ratings?.kick!=null&&ski.ratings?.glide!=null?ski.ratings.kick+ski.ratings.glide:null);
        log.push([sess.name,test.name||"",test.testers||"",test.category,test.type||"",ski.id,ski.product||"",ski.application||"",ski.notes||"",ski.ratings?.kick??null,ski.ratings?.glide??null,comp??null,ski.standing||"",ski.feelNotes||""]);
      });
      // Glide-out results as separate rows
      if (test.category==="glide-out" || test.type==="Glide Out") {
        const goResults = calcGlideOutResults(test.glideOutRuns, test.skis);
        goResults.forEach(r => {
          log.push([sess.name,test.name||"",test.testers||"","glide","Glide Out",r.skiId,r.product||"",r.application||"","",null,null,null,r.cmGap===0?"Winner":`+${r.cmGap}cm`,"Glide out result"]);
        });
      }

    });
  });
  return {info,cond,log,snow};
}
function ExportPanel({ event }) {
  function doXLSX() {
    const {info,cond,log,snow}=buildSheets(event);
    const wb=window.XLSX.utils.book_new();
    [["Event Info",info],["Conditions",cond],["Test Log",log],["Temperatures",snow]].forEach(([name,data])=>
      window.XLSX.utils.book_append_sheet(wb,window.XLSX.utils.aoa_to_sheet(data),name));
    const blob=new Blob([window.XLSX.write(wb,{bookType:"xlsx",type:"array"})],{type:"application/octet-stream"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=`${(event.name||"waxlab").replace(/\s+/g,"-")}.xlsx`; a.click();
  }
  return <div>
    <button className="btn" onClick={doXLSX} style={{ width:"100%", marginBottom:12 }}>Download Excel (.xlsx)</button>
  </div>;
}

// ─── PHOTO COMPONENTS ────────────────────────────────────────────────────────

// PhotoViewer: full-screen image overlay, swipe down or tap × to close
function PhotoViewer({ photo, onClose }) {
  const [imgSrc, setImgSrc] = useState(photo.thumb || null);
  useEffect(() => {
    resolvePhotoUrl(photo).then(url => { if (url) setImgSrc(url); });
  }, [photo]);
  // Swipe down to close
  const startY = useRef(null);
  function onTouchStart(e) { startY.current = e.touches[0].clientY; }
  function onTouchEnd(e) {
    if (startY.current != null && e.changedTouches[0].clientY - startY.current > 80) onClose();
  }
  return (
    <div onClick={onClose} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:2000,
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
      <div style={{ position:"absolute", top:16, right:16 }}>
        <button onClick={onClose} style={{ background:"none", border:"none", color:"#fff",
          fontSize:32, lineHeight:1, cursor:"pointer" }}>×</button>
      </div>
      {imgSrc
        ? <img src={imgSrc} alt={photo.caption||""}
            onClick={e=>e.stopPropagation()}
            style={{ maxWidth:"100%", maxHeight:"80vh", objectFit:"contain", borderRadius:4 }} />
        : <div style={{ color:"rgba(255,255,255,0.4)", fontSize:14 }}>Loading…</div>
      }
      {photo.caption && (
        <div style={{ color:"rgba(255,255,255,0.75)", fontSize:14, marginTop:12,
          padding:"0 24px", textAlign:"center" }}>{photo.caption}</div>
      )}
      <div style={{ color:"rgba(255,255,255,0.3)", fontSize:12, marginTop:8 }}>
        {fmtDateTime(photo.ts)}
      </div>
    </div>
  );
}

function PhotoSheet({ ski, teamCode, eventId, onSave, onClose }) {
  const [photos, setPhotos]     = useState(ski.photos || []);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing]   = useState(null); // photo being viewed full-screen
  const [editCaption, setEditCaption] = useState(null); // { index, value }
  const fileRef = useRef(null);

  async function handleFiles(files) {
    if (!files?.length) return;
    setUploading(true);
    const added = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const photo = await uploadPhoto(teamCode, eventId, ski.id, file);
        added.push(photo);
      } catch (e) {
        console.warn("Photo upload error:", e.message);
      }
    }
    const updated = [...photos, ...added];
    setPhotos(updated);
    onSave(updated);
    setUploading(false);
  }

  async function removePhoto(index) {
    const photo = photos[index];
    await deletePhoto(photo);
    const updated = photos.filter((_, i) => i !== index);
    setPhotos(updated);
    onSave(updated);
  }

  function saveCaption(index, value) {
    const updated = photos.map((p, i) => i === index ? { ...p, caption: value } : p);
    setPhotos(updated);
    onSave(updated);
    setEditCaption(null);
  }

  return (
    <>
      {viewing && <PhotoViewer photo={viewing} onClose={() => setViewing(null)} />}
      <div onClick={onClose}
        style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:300 }}>
        <div onClick={e => e.stopPropagation()}
          style={{ position:"fixed", bottom:0, left:0, right:0, background:"var(--paper)",
            borderRadius:"16px 16px 0 0", padding:"20px 20px 40px", maxHeight:"85vh",
            overflowY:"auto", zIndex:301 }}>

          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div>
              <span style={{ fontSize:17, fontWeight:700 }}>Photos</span>
              <span className="mono" style={{ fontSize:12, color:"var(--ink-faint)", marginLeft:10 }}>
                {ski.id}{!ski.product ? "" : ` · ${ski.product}`}
              </span>
            </div>
            <button onClick={onClose} className="btn-text" style={{ fontSize:24 }}>×</button>
          </div>

          {/* Capture buttons */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
            <button className="btn" style={{ fontSize:14 }}
              onClick={() => { fileRef.current.removeAttribute("capture"); fileRef.current.click(); }}>
              From Library
            </button>
            <button className="btn" style={{ fontSize:14 }}
              onClick={() => { fileRef.current.setAttribute("capture","environment"); fileRef.current.click(); }}>
              Camera
            </button>
          </div>

          {/* Hidden file input */}
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display:"none" }}
            onChange={e => handleFiles(e.target.files)} />

          {uploading && (
            <div style={{ textAlign:"center", padding:"12px 0", fontSize:14,
              color:"var(--ink-faint)" }}>Uploading…</div>
          )}

          {/* Photo grid */}
          {photos.length === 0 && !uploading && (
            <div style={{ textAlign:"center", padding:"24px 0", color:"var(--ink-faint)", fontSize:14 }}>
              No photos yet. Tap Camera or Library to add one.
            </div>
          )}

          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
            {photos.map((photo, i) => (
              <div key={photo.id} style={{ position:"relative" }}>
                {/* Thumbnail */}
                <div onClick={() => setViewing(photo)}
                  style={{ aspectRatio:"1", borderRadius:6, overflow:"hidden",
                    background:"var(--paper-3)", cursor:"pointer" }}>
                  {photo.thumb
                    ? <img src={photo.thumb} alt={photo.caption||""}
                        style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                    : <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
                        height:"100%", fontSize:24 }}>🖼</div>
                  }
                </div>
                {/* Delete button */}
                <button onClick={() => removePhoto(i)}
                  style={{ position:"absolute", top:4, right:4, background:"rgba(0,0,0,0.55)",
                    border:"none", color:"#fff", borderRadius:"50%", width:22, height:22,
                    fontSize:14, lineHeight:"22px", textAlign:"center", cursor:"pointer",
                    padding:0 }}>×</button>
                {/* Caption */}
                {editCaption?.index === i
                  ? <div style={{ marginTop:4 }}>
                      <input className="inp" autoFocus value={editCaption.value}
                        onChange={e => setEditCaption({ index:i, value:e.target.value })}
                        onBlur={() => saveCaption(i, editCaption.value)}
                        onKeyDown={e => e.key === "Enter" && saveCaption(i, editCaption.value)}
                        style={{ fontSize:12, padding:"4px 6px" }} />
                    </div>
                  : <div onClick={() => setEditCaption({ index:i, value:photo.caption||"" })}
                      style={{ marginTop:4, fontSize:11, color:"var(--ink-faint)",
                        cursor:"pointer", minHeight:16, textAlign:"center", lineHeight:1.3 }}>
                      {photo.caption || <span style={{ color:"var(--rule)" }}>add caption</span>}
                      {photo.sizeKb && (
                        <div style={{ fontSize:9, color:"var(--rule)", marginTop:1 }}>
                          {photo.sizeKb} KB
                        </div>
                      )}
                    </div>
                }
              </div>
            ))}
          </div>

          {/* Supabase storage note for local-only mode */}
          {!supabaseConfigured && photos.some(p => p.url?.startsWith("idb://")) && (
            <div style={{ marginTop:16, padding:"10px 12px", background:"var(--paper-2)",
              borderRadius:6, fontSize:12, color:"var(--ink-faint)", lineHeight:1.5 }}>
              ⚠ Photos are saved locally on this device only. Configure Supabase to share
              photos across your team.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── TOURNAMENT SKI CARD ──────────────────────────────────────────────────────
function TournamentSkiCard({ ski, isGlide, isBlind, onAdvance, onEliminate, onRunnerUp, onRatingChange, onPhotoSave, teamCode, eventId, defaultExpanded, selected, onSelect }) {
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const [showPhotos, setShowPhotos] = useState(false);
  const ratings = ski.ratings||{};
  function setR(field,val) { onRatingChange(ski.id,{...ratings,[field]:val}); }
  const kick=ratings.kick, glide=ratings.glide;
  const composite = isGlide?glide:(kick!=null&&glide!=null?kick+glide:null);
  const max = isGlide?10:20;

  return <SwipeCard onSwipeRight={onAdvance} onSwipeLeft={onEliminate} style={{ marginBottom:10 }}>
    <div className="card" style={{ border:selected?"2px solid var(--blue)":undefined }}>
      {showPhotos && onPhotoSave && (
        <PhotoSheet ski={ski} teamCode={teamCode} eventId={eventId}
          onSave={photos=>onPhotoSave(ski.id,photos)} onClose={()=>setShowPhotos(false)} />
      )}
      <div style={{ padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <span className="mono" style={{ fontSize:16, fontWeight:700 }}>{ski.id}</span>
          {!isBlind&&ski.product&&<span style={{ fontSize:14, marginLeft:10, color:"var(--ink-mid)" }}>{ski.product}</span>}
          {isBlind&&<span className="tag" style={{ marginLeft:8, color:"var(--ink-faint)", fontSize:9 }}>blind</span>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {(ski.photos?.length>0) && (
            <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
              {ski.photos.length} Photo{ski.photos.length!==1?"s":""}
            </span>
          )}
          {composite!=null&&<RatingBadge score={composite} max={max} />}
                    {onSelect&&<button onClick={e=>{e.stopPropagation();onSelect();}} className="btn-ghost"
            style={{ padding:"6px 10px", fontSize:12, minHeight:34,
              color:selected?"var(--blue)":"var(--ink-faint)",
              borderColor:selected?"var(--blue)":"var(--rule)",
              fontWeight:selected?700:400 }}>
            {selected?"In pair":"+ Pair"}
          </button>}
          <button onClick={()=>setShowPhotos(true)} className="btn-ghost"
            style={{ padding:"6px 10px", fontSize:12, fontWeight:600, minHeight:34 }}>Photo</button>
          <button onClick={()=>setExpanded(o=>!o)} className="btn-ghost"
            style={{ padding:"6px 12px", fontSize:12, minHeight:34 }}>
            {expanded?"Hide":"★ Rate"}
          </button>
        </div>
      </div>

      {expanded&&<div style={{ padding:"0 14px 12px", borderTop:"1px solid var(--rule)" }}>
        {!isGlide&&<>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:12, marginBottom:8 }}>
            <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)", width:70, flexShrink:0 }}>KICK 1–10</span>
            <input type="range" min={1} max={10} value={kick??5}
              onChange={e=>setR("kick",Number(e.target.value))} style={{ flex:1 }} />
            <span className="mono" style={{ fontSize:18, fontWeight:700, width:32, textAlign:"right",
              color:kick!=null?compositeColor(kick,10):"var(--ink-faint)" }}>{kick??"-"}</span>
          </div>
        </>}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:!isGlide?0:12, marginBottom:8 }}>
          <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)", width:70, flexShrink:0 }}>GLIDE 1–10</span>
          <input type="range" min={1} max={10} value={glide??5}
            onChange={e=>setR("glide",Number(e.target.value))} style={{ flex:1 }} />
          <span className="mono" style={{ fontSize:18, fontWeight:700, width:32, textAlign:"right",
            color:glide!=null?compositeColor(glide,10):"var(--ink-faint)" }}>{glide??"-"}</span>
        </div>
        {composite!=null&&<div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8 }} className="mono">
          Composite: <span style={{ color:compositeColor(composite,max), fontWeight:700 }}>{composite}/{max}</span>
        </div>}
        <textarea className="inp" rows={2} value={ski.feelNotes||""} placeholder="Feel notes…"
          style={{ fontSize:13, marginBottom:0 }}
          onChange={e=>onRatingChange(ski.id,ratings,{feelNotes:e.target.value})} />
      </div>}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr" }}>
        <button className="btn-advance" onClick={onAdvance}>▲ Advance</button>
        <button style={{ background:"var(--amber)", color:"#fff", border:"none",
          padding:"20px 0", fontSize:13, fontWeight:700, cursor:"pointer" }}
          onClick={onRunnerUp}>2nd</button>
        <button className="btn-eliminate" onClick={onEliminate}>✕ Eliminate</button>
      </div>
      <div style={{ padding:"5px 0 6px", textAlign:"center" }} className="mono">
        <span style={{ fontSize:10, color:"var(--ink-faint)", letterSpacing:"0.04em" }}>swipe → advance  ·  swipe ← eliminate</span>
      </div>
    </div>
  </SwipeCard>;
}

// ─── SKI CARD (Results tab) ───────────────────────────────────────────────────
function SkiCard({ ski, isGlide, isBlind, onRatingChange, onPhotoSave, teamCode, eventId }) {
  const [open, setOpen] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const ratings=ski.ratings||{};
  function setR(field,val) { onRatingChange(ski.id,{...ratings,[field]:val}); }
  const composite = isGlide?ratings.glide:(ratings.kick!=null&&ratings.glide!=null?ratings.kick+ratings.glide:null);
  const max=isGlide?10:20;
  const sColor=ski.standing==="Winner"?"var(--green)":ski.standing==="Runner-Up"?"var(--amber)":ski.standing==="Eliminated"?"var(--red)":"var(--ink-faint)";
  return <div className="card" style={{ marginBottom:8 }}>
    {showPhotos && onPhotoSave && (
      <PhotoSheet ski={ski} teamCode={teamCode} eventId={eventId}
        onSave={photos=>onPhotoSave(ski.id,photos)} onClose={()=>setShowPhotos(false)} />
    )}
    <div onClick={()=>setOpen(o=>!o)} style={{ padding:"12px 14px", display:"flex",
      justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}>
      <div>
        <span className="mono" style={{ fontSize:14, fontWeight:700 }}>{ski.id}</span>
        {!isBlind&&ski.product&&<span style={{ fontSize:13, marginLeft:8 }}>{ski.product}</span>}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        {(ski.photos?.length>0) && (
          <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
            {ski.photos.length} Photo{ski.photos.length!==1?"s":""}
          </span>
        )}
        {composite!=null&&<RatingBadge score={composite} max={max} />}
        {ski.standing&&<span className="tag" style={{ color:sColor, fontSize:9 }}>{ski.standing}</span>}
        <button onClick={e=>{ e.stopPropagation(); setShowPhotos(true); }}
          className="btn-ghost" style={{ padding:"5px 9px", fontSize:12, fontWeight:600, minHeight:32 }}>Photo</button>
        <span style={{ color:"var(--ink-faint)", fontSize:12 }}>{open?"▲":"▼"}</span>
      </div>
    </div>
    {open&&<div style={{ padding:"0 14px 12px", borderTop:"1px solid var(--rule)" }}>
      {!isBlind&&ski.application&&<div style={{ fontSize:13, color:"var(--ink-mid)", marginBottom:8 }}>{ski.application}</div>}
      {!isGlide&&<>
        <Lbl>Kick Rating 1–10</Lbl>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <input type="range" min={1} max={10} value={ratings.kick??5}
            onChange={e=>setR("kick",Number(e.target.value))} style={{ flex:1 }} />
          <span className="mono" style={{ fontSize:18, fontWeight:700, width:32, textAlign:"right" }}>{ratings.kick??"-"}</span>
        </div>
      </>}
      <Lbl>Glide Rating 1–10</Lbl>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
        <input type="range" min={1} max={10} value={ratings.glide??5}
          onChange={e=>setR("glide",Number(e.target.value))} style={{ flex:1 }} />
        <span className="mono" style={{ fontSize:18, fontWeight:700, width:32, textAlign:"right" }}>{ratings.glide??"-"}</span>
      </div>
      {composite!=null&&<div className="mono" style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8 }}>
        Composite: <span style={{ color:compositeColor(composite,max), fontWeight:700 }}>{composite}/{max}</span>
      </div>}
      <TA label="Feel Notes" value={ski.feelNotes}
        onChange={v=>onRatingChange(ski.id,ratings,{feelNotes:v})} rows={2} style={{ marginBottom:0 }} />
    </div>}
  </div>;
}

// ─── TEST VIEW ────────────────────────────────────────────────────────────────
function TestView({ test, onUpdate, onBack, vocab, onVocabAdd, useCelsius, onUnitToggle, teamCode, eventId, fleets=[] }) {
  const [tab, setTab] = useState(test.category === "glide-out" || test.type === "Glide Out" ? "glideout" : "tournament");
  const [undoStack, setUndoStack] = useState([]);
  const [undoVisible, setUndoVisible] = useState(false);
  const [currentPair, setCurrentPair] = useState(null); // [skiId, skiId] or null
  const [newId, setNewId] = useState("");
  const [newProduct, setNewProduct] = useState("");
  const [newApp, setNewApp] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [showDeadlinePicker, setShowDeadlinePicker] = useState(false);
  const [rewaxId, setRewaxId] = useState(null);   // ski being re-entered with new product
  const [rewaxProduct, setRewaxProduct] = useState("");
  const [rewaxApp, setRewaxApp] = useState("");
  const isGlide = test.category==="glide"||test.category==="glide-out";
  const activeSki = (test.skis||[]).filter(s=>s.standing==="Active");
  const eliminated = (test.skis||[]).filter(s=>s.standing==="Eliminated");
  const winner = (test.skis||[]).find(s=>s.standing==="Winner");
  const isBlind = test.blindMode&&!test.blindRevealed;

  function upd(patch) { onUpdate({...test,...patch}); }
  function updSki(skiId,patch) { upd({skis:(test.skis||[]).map(s=>s.id===skiId?{...s,...patch}:s)}); }

  function pushUndo(snapshot,label) { setUndoStack(p=>[{snapshot,label},...p.slice(0,9)]); setUndoVisible(true); }
  function doUndo() { if(!undoStack.length) return; upd({skis:undoStack[0].snapshot}); setUndoStack(p=>p.slice(1)); setUndoVisible(false); }

  function advance(skiId) {
    const snap=[...(test.skis||[])];
    const remaining=activeSki.filter(s=>s.id!==skiId);
    let newSkis=(test.skis||[]).map(s=>s.id===skiId?{...s,standing:remaining.length===0?"Winner":"Active"}:s);
    // Record the match in bracket history
    const opponentId = currentPair ? currentPair.find(id=>id!==skiId) : null;
    const roundNum = (test.rounds||[]).length + 1;
    const newRound = { roundNum, winner:skiId, loser:opponentId||null };
    upd({skis:newSkis, rounds:[...(test.rounds||[]),newRound]});
    pushUndo(snap,`Advanced ${skiId}`);
    setCurrentPair(null);
  }
  function eliminate(skiId) {
    const snap=[...(test.skis||[])];
    const opponentId = currentPair ? currentPair.find(id=>id!==skiId) : null;
    const roundNum = (test.rounds||[]).length + 1;
    const newRound = { roundNum, winner:opponentId||null, loser:skiId };
    upd({skis:(test.skis||[]).map(s=>s.id===skiId?{...s,standing:"Eliminated"}:s),
         rounds:[...(test.rounds||[]),newRound]});
    pushUndo(snap,`Eliminated ${skiId}`);
    setCurrentPair(null);
  }
  function restore(skiId) { updSki(skiId,{standing:"Active"}); }
  function startRewax(ski) {
    setRewaxId(ski.id);
    setRewaxProduct(ski.product||"");
    setRewaxApp(ski.application||"");
  }
  function confirmRewax() {
    // Keep the ski's ID and history, just update product/application and re-activate
    updSki(rewaxId, { product:rewaxProduct, application:rewaxApp, standing:"Active", ratings:{}, feelNotes:"" });
    if (rewaxProduct) onVocabAdd?.("products",[rewaxProduct]);
    if (rewaxApp) onVocabAdd?.("applications",[rewaxApp]);
    setRewaxId(null); setRewaxProduct(""); setRewaxApp("");
  }
  function declareWinner(skiId) {
    const snap=[...(test.skis||[])];
    const losers = activeSki.filter(s=>s.id!==skiId);
    const finalRound = { roundNum:(test.rounds||[]).length+1, winner:skiId, loser:losers.length===1?losers[0].id:null };
    upd({skis:(test.skis||[]).map(s=>({...s,standing:s.id===skiId?"Winner":"Eliminated"})),
         rounds:[...(test.rounds||[]),finalRound]});
    pushUndo(snap,"Winner declared");
  }
  function markRunnerUp(skiId) {
    const snap=[...(test.skis||[])];
    // Only one ski can be Runner-Up — mark this one, clear others from Runner-Up back to Eliminated
    upd({skis:(test.skis||[]).map(s=>({
      ...s, standing: s.id===skiId ? "Runner-Up"
            : s.standing==="Runner-Up" ? "Eliminated"
            : s.standing
    }))});
    pushUndo(snap,"Runner-Up marked");
  }
  function updateRating(skiId,ratings,extra={}) { updSki(skiId,{ratings,...extra}); }
  function updatePhotos(skiId,photos) { updSki(skiId,{photos}); }

  function suggestPair() {
    const rated=activeSki.filter(s=>s.ratings?.glide!=null||(s.ratings?.kick!=null&&!isGlide));
    if (rated.length>=2) {
      let best=null,bestDiff=Infinity;
      for(let i=0;i<rated.length;i++) for(let j=i+1;j<rated.length;j++) {
        const a=rated[i],b=rated[j];
        const sa=isGlide?a.ratings.glide:a.ratings.kick+a.ratings.glide;
        const sb=isGlide?b.ratings.glide:b.ratings.kick+b.ratings.glide;
        const d=Math.abs(sa-sb); if(d<bestDiff){bestDiff=d;best=[a,b];}
      }
      return best;
    }
    return activeSki.length>=2?[activeSki[0],activeSki[1]]:null;
  }

  function addSki() {
    const id=newId.trim()||nextSkiId(test.skis);
    const ski={id,product:newProduct.trim(),application:newApp.trim(),standing:"Active",ratings:{}};
    upd({skis:[...(test.skis||[]),ski]});
    if(newProduct) onVocabAdd?.("products",[newProduct.trim()]);
    if(newApp) onVocabAdd?.("applications",[newApp.trim()]);
    setNewId(""); setNewProduct(""); setNewApp("");
  }
  function removeSki(id) { upd({skis:(test.skis||[]).filter(s=>s.id!==id)}); }
  function saveEdit(id,patch) {
    updSki(id,patch);
    if(patch.product) onVocabAdd?.("products",[patch.product]);
    if(patch.application) onVocabAdd?.("applications",[patch.application]);
    setEditingId(null);
  }

  const suggestion=tab==="tournament"?suggestPair():null;
  const isGlideOut = test.category === "glide-out" || test.type === "Glide Out";
  const TABS = [
    ...(isGlideOut ? [{id:"glideout",label:"Glide Out"}] : [{id:"tournament",label:"Tournament"}]),
    {id:"fleet",label:"Fleet"},
    {id:"results",label:"Results"},
    {id:"notes",label:"Notes"},
  ];

  return <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
    <div className="view-header no-print">
      <BackBtn onClick={onBack} />
      <div style={{ textAlign:"center" }}>
        <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", letterSpacing:"0.06em",
          textTransform:"uppercase" }}>
          {test.category==="glide-out"?"Glide Out":test.category}
          {test.type?` · ${test.type}`:""}
        </div>
        <div style={{ fontSize:15, fontWeight:700 }}>{test.name}</div>
        {test.testers && (
          <div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:1 }}>{test.testers}</div>
        )}
      </div>
      <div className="mono" style={{ fontSize:12, color:"var(--ink-faint)" }}>{activeSki.length} active</div>
    </div>

    {showDeadlinePicker && <DeadlinePicker test={test}
      onSave={patch=>upd(patch)}
      onClose={()=>setShowDeadlinePicker(false)} />}

    <div className="tab-bar no-print">
      {TABS.map(t=><button key={t.id} className={`tab-btn${tab===t.id?" active":""}`}
        onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </div>

    <div style={{ padding:16, paddingBottom:80 }}>

      {/* ── TOURNAMENT ── */}
      {tab==="tournament"&&<div>
        {test.blindMode&&<div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"10px 14px", background:"var(--paper-2)", borderRadius:8, marginBottom:12 }}>
          <span style={{ fontSize:13, fontWeight:600 }}>{test.blindRevealed?"Products revealed":"Blind mode on"}</span>
          <button className="btn-ghost" style={{ fontSize:12, padding:"6px 14px", minHeight:34 }}
            onClick={()=>upd({blindRevealed:!test.blindRevealed})}>
            {test.blindRevealed?"Re-blind":"Reveal"}
          </button>
        </div>}

        {winner&&<div style={{ padding:"14px 16px", background:"var(--paper-2)", borderRadius:8,
          border:"2px solid var(--green)", marginBottom:16 }}>
          <Lbl style={{ color:"var(--green)", marginBottom:6 }}>Winner</Lbl>
          <div style={{ fontSize:20, fontWeight:800 }}>{!isBlind?winner.product||winner.id:winner.id}</div>
          {!isBlind&&winner.application&&<div style={{ fontSize:13, color:"var(--ink-mid)", marginTop:2 }}>{winner.application}</div>}
          {winner.ratings&&<div style={{ marginTop:10 }}>
            <RatingBadge score={isGlide?winner.ratings.glide:(winner.ratings.kick+winner.ratings.glide)} max={isGlide?10:20} />
          </div>}
        </div>}

        {activeSki.length>=2&&!winner&&<div style={{ padding:"10px 14px",
          background:"var(--paper-2)", borderRadius:8, marginBottom:12,
          border:currentPair?"2px solid var(--blue)":"1.5px solid var(--rule)" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <Lbl style={{ marginBottom:0, color:currentPair?"var(--blue)":"var(--ink-faint)" }}>
              {currentPair ? "Active pair" : "Select pair to compare"}
            </Lbl>
            {suggestion&&!currentPair&&(
              <button className="btn-ghost"
                style={{ fontSize:11, padding:"3px 8px", minHeight:26 }}
                onClick={()=>setCurrentPair([suggestion[0].id,suggestion[1].id])}>
                Use suggested
              </button>
            )}
            {currentPair&&(
              <button className="btn-ghost"
                style={{ fontSize:11, padding:"3px 8px", minHeight:26 }}
                onClick={()=>setCurrentPair(null)}>
                Clear
              </button>
            )}
          </div>
          {currentPair ? (
            <div style={{ fontSize:14, fontWeight:600 }}>
              {currentPair.map((id,i)=>{
                const ski=activeSki.find(s=>s.id===id)||{};
                return <span key={id}>
                  {i>0&&<span style={{ color:"var(--ink-faint)", margin:"0 10px" }}>vs</span>}
                  <span className="mono">{id}</span>
                  {!isBlind&&ski.product&&<span style={{ color:"var(--ink-mid)", fontWeight:400, marginLeft:6 }}>{ski.product}</span>}
                </span>;
              })}
            </div>
          ) : suggestion ? (
            <div style={{ fontSize:13, color:"var(--ink-faint)" }}>
              Suggested: <span className="mono">{suggestion[0].id}</span>
              <span style={{ margin:"0 6px" }}>vs</span>
              <span className="mono">{suggestion[1].id}</span>
              {!isBlind&&suggestion[0].product&&<span style={{ color:"var(--ink-mid)", marginLeft:4 }}>({suggestion[0].product})</span>}
              — tap "Use suggested" or tap skis below
            </div>
          ) : (
            <div style={{ fontSize:13, color:"var(--ink-faint)" }}>
              Tap <strong style={{ color:"var(--ink)" }}>+ Pair</strong> on two skis below to mark them as the active comparison
            </div>
          )}
        </div>}

        {activeSki.length===0&&!winner&&<div style={{ textAlign:"center", padding:"32px 0",
          color:"var(--ink-faint)", fontSize:14 }}>
          Add skis in the Fleet tab to begin.
        </div>}


        {/* ── RATING INTELLIGENCE ── */}
        {(()=>{
          // Build composite score for every ski that has any rating
          const getComp = ski => {
            const r = ski.ratings||{};
            if (isGlide) return r.glide ?? null;
            return (r.kick!=null && r.glide!=null) ? r.kick+r.glide : (r.glide??r.kick??null);
          };
          const max = isGlide ? 10 : 20;

          // Rating-based leader among still-active skis
          const rated = activeSki.filter(s => getComp(s) != null)
            .sort((a,b) => getComp(b)-getComp(a));
          const leader = rated[0];

          // After winner: check if any eliminated ski was rated higher
          const conflicted = winner ? (test.skis||[])
            .filter(s => s.standing==="Eliminated" && getComp(s)!=null &&
                         getComp(winner)!=null && getComp(s) > getComp(winner))
            .sort((a,b)=>getComp(b)-getComp(a)) : [];

          return <>
            {/* Rating leader banner (pre-winner, ≥1 rated active ski) */}
            {!winner && leader && activeSki.length >= 2 && (
              <div style={{ padding:"10px 14px", background:"var(--paper-2)", borderRadius:8,
                marginBottom:12, border:"1.5px solid var(--rule)" }}>
                <Lbl style={{ marginBottom:4, color:"var(--green)" }}>Rated leader</Lbl>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <span className="mono" style={{ fontSize:14, fontWeight:700 }}>{leader.id}</span>
                    {!isBlind&&leader.product&&<span style={{ fontSize:13, color:"var(--ink-mid)",
                      marginLeft:8 }}>{leader.product}</span>}
                    <div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:2 }}>
                      {getComp(leader)}/{max} feel score · {rated.length} of {activeSki.length} skis rated
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <RatingBadge score={getComp(leader)} max={max} />
                    <button className="btn-ghost"
                      style={{ fontSize:12, padding:"5px 10px", minHeight:32,
                        color:"var(--green)", borderColor:"var(--green)" }}
                      onClick={()=>declareWinner(leader.id)}>
                      Declare
                    </button>
                  </div>
                </div>
                {rated.length >= 2 && (
                  <div style={{ marginTop:8, borderTop:"1px solid var(--rule)", paddingTop:8 }}>
                    {rated.slice(0,4).map((s,i) => (
                      <div key={s.id} style={{ display:"flex", justifyContent:"space-between",
                        fontSize:11, color:i===0?"var(--ink)":"var(--ink-faint)", paddingBottom:2 }}>
                        <span className="mono">#{i+1} {s.id}{!isBlind&&s.product?` — ${s.product}`:""}</span>
                        <span className="mono" style={{ fontWeight:600 }}>{getComp(s)}/{max}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Consistency warning — winner rated lower than an eliminated ski */}
            {winner && conflicted.length > 0 && (
              <div style={{ padding:"10px 14px", background:"var(--paper-2)", borderRadius:8,
                marginBottom:12, border:"1.5px solid var(--amber)" }}>
                <div style={{ fontSize:12, fontWeight:700, color:"var(--amber)", marginBottom:4 }}>
                  ⚠ Rating inconsistency
                </div>
                <div style={{ fontSize:12, color:"var(--ink-mid)", lineHeight:1.5 }}>
                  {conflicted.map(s=>(
                    <span key={s.id}>
                      <span className="mono">{s.id}</span> was eliminated but rated{" "}
                      <strong>{getComp(s)}/{max}</strong> vs winner{" "}
                      <span className="mono">{winner.id}</span>{" "}
                      <strong>{getComp(winner)}/{max}</strong>.{" "}
                    </span>
                  ))}
                  Consider re-testing.
                </div>
              </div>
            )}
          </>;
        })()}

        {/* Voice command bar — mic → parse → confirm → execute */}
        <VoiceCommandBar
          skis={test.skis} isGlide={isGlide}
          onAdvance={!winner ? (id => { const s=activeSki.find(x=>x.id===id); if(s) advance(id); }) : null}
          onEliminate={!winner ? (id => { const s=activeSki.find(x=>x.id===id); if(s) eliminate(id); }) : null}
          onWinner={!winner ? (id => declareWinner(id)) : null}
          onRestore={id => restore(id)}
          onRate={(id, {glide,kick}) => {
            const ski = (test.skis||[]).find(x=>x.id===id);
            if (!ski) return;
            const r = {...(ski.ratings||{})};
            if (glide != null) r.glide = glide;
            if (kick  != null) r.kick  = kick;
            updateRating(id, r);
          }}
          onPair={(id1, id2) => {
            // Voice pair selection: validate both IDs are active, then set as current pair
            const s1 = activeSki.find(s=>s.id===id1);
            const s2 = activeSki.find(s=>s.id===id2);
            if (s1 && s2) setCurrentPair([id1, id2]);
          }}
          onRunnerUp={id => markRunnerUp(id)}
        />

        {activeSki.map((ski,i)=>{
          const inPair = (currentPair||[]).includes(ski.id);
          function togglePair() {
            setCurrentPair(prev => {
              const ids = (prev||[]).filter(Boolean);
              if (ids.includes(ski.id)) {
                const next = ids.filter(id=>id!==ski.id);
                return next.length ? next : null;
              }
              return ids.length >= 2 ? [ids[1], ski.id] : [...ids, ski.id];
            });
          }
          return <TournamentSkiCard key={ski.id} ski={ski} isGlide={isGlide}
            isBlind={isBlind} onAdvance={()=>advance(ski.id)} onEliminate={()=>eliminate(ski.id)}
            onRunnerUp={()=>markRunnerUp(ski.id)}
            onRatingChange={updateRating} onPhotoSave={updatePhotos}
            teamCode={teamCode} eventId={eventId} defaultExpanded={i===0}
            selected={inPair} onSelect={togglePair} />;
        })}

        {activeSki.length===1&&!winner&&<button className="btn" style={{ width:"100%", marginTop:8 }}
          onClick={()=>declareWinner(activeSki[0].id)}>
          Declare Winner: {activeSki[0].id}
        </button>}

        {eliminated.length>0&&<>
          <Hr />
          <Lbl>Eliminated ({eliminated.length})</Lbl>
          {eliminated.map(ski=>(
            rewaxId===ski.id
              ? <div key={ski.id} className="card" style={{ padding:14, marginBottom:8,
                  border:"2px solid var(--blue)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                    <span className="mono" style={{ fontSize:14, fontWeight:700 }}>{ski.id}</span>
                    <span className="tag" style={{ color:"var(--blue)", fontSize:9 }}>Re-entering</span>
                  </div>
                  <ACI label="New Product" value={rewaxProduct} onChange={setRewaxProduct}
                    onCommit={v=>onVocabAdd?.("products",[v])}
                    suggestions={vocab?.products||[]} placeholder="New wax product…" style={{ marginBottom:8 }} />
                  <ACI label="New Application" value={rewaxApp} onChange={setRewaxApp}
                    onCommit={v=>onVocabAdd?.("applications",[v])}
                    suggestions={vocab?.applications||[]} placeholder="Iron temp, layers…" style={{ marginBottom:10 }} />
                  <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:12, lineHeight:1.5 }}>
                    Ski {ski.id} returns to Active with fresh ratings. Previous result is cleared.
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button className="btn" style={{ flex:2 }} onClick={confirmRewax}>Re-enter {ski.id}</button>
                    <button className="btn-ghost" style={{ flex:1 }} onClick={()=>setRewaxId(null)}>Cancel</button>
                  </div>
                </div>
              : <div key={ski.id} style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", padding:"10px 0", borderBottom:"1px solid var(--rule)", gap:8 }}>
                  <div style={{ opacity:0.7, flex:1, minWidth:0 }}>
                    <span className="mono" style={{ fontSize:13, fontWeight:700 }}>{ski.id}</span>
                    {!isBlind&&ski.product&&<span style={{ fontSize:13, color:"var(--ink-mid)", marginLeft:8 }}>{ski.product}</span>}
                    {!isBlind&&ski.application&&<div style={{ fontSize:11, color:"var(--ink-faint)", marginTop:1 }}>{ski.application}</div>}
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexShrink:0 }}>
                    {ski.ratings&&<RatingBadge score={isGlide?ski.ratings.glide:(ski.ratings.kick!=null&&ski.ratings.glide!=null?ski.ratings.kick+ski.ratings.glide:null)} max={isGlide?10:20} />}
                    <button className="btn-ghost" style={{ fontSize:12, padding:"4px 10px", minHeight:30 }}
                      onClick={()=>restore(ski.id)}>Restore</button>
                    <button className="btn-ghost" style={{ fontSize:12, padding:"4px 10px", minHeight:30,
                      color:"var(--blue)", borderColor:"var(--blue)" }}
                      onClick={()=>startRewax(ski)}>Re-wax ↺</button>
                  </div>
                </div>
          ))}
        </>}
      </div>}

      {/* ── GLIDE OUT ── */}
      {tab==="glideout"&&<GlideOutTab test={test} onUpdate={onUpdate} isBlind={isBlind} />}

      {/* ── FLEET ── */}
      {tab==="fleet"&&<div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
          <div>
            <Lbl>Category</Lbl>
            <select className="inp" value={test.category||"glide"} onChange={e=>upd({category:e.target.value,type:""})}>
              <option value="glide">Glide</option>
              <option value="kick">Kick</option>
            </select>
          </div>
          <div>
            <Lbl>Test Type</Lbl>
            <select className="inp" value={test.type||""} onChange={e=>upd({type:e.target.value})}>
              <option value="">— select —</option>
              {(test.category==="glide"||test.category==="glide-out"
                  ? ["Topcoat","Paraffin","Hand structure","Grind"]
                  : test.category==="kick"
                  ? ["Binder","Mid layer","Top layer","Full stack"]
                  : []
                ).map(o=><option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <TI label="Test Name" value={test.name} onChange={v=>upd({name:v})} style={{ marginBottom:8 }} mic />
        <TI label="Tester(s)" value={test.testers||""} onChange={v=>upd({testers:v})}
          placeholder="Names or initials of skiers conducting this test"
          style={{ marginBottom:12 }} />

        {/* Deadline row in Fleet tab */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
          <div style={{ flex:1 }}>
            {test.deadline
              ? <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <CountdownBadge deadline={test.deadline} />
                  <span style={{ fontSize:12, color:"var(--ink-faint)" }}>
                    {new Date(test.deadline).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}
                    {test.deadlineLabel ? ` — ${test.deadlineLabel}` : ""}
                  </span>
                </div>
              : <span style={{ fontSize:12, color:"var(--ink-faint)" }}>No deadline set</span>
            }
          </div>
          <button onClick={()=>setShowDeadlinePicker(true)} className="btn-ghost"
            style={{ fontSize:13, padding:"6px 12px", minHeight:34 }}>
            {test.deadline ? "⏱ Edit" : "⏱ Set Deadline"}
          </button>
        </div>

        {/* ── FLEET PRESET LOADER ── */}
        {fleets.filter(f => f.category === test.category || (test.category==="glide-out" && f.category==="glide")).length > 0 && (
          <div style={{ marginBottom:16 }}>
            <Lbl>Load from Fleet Registry</Lbl>
            {fleets.filter(f => f.category === test.category || (test.category==="glide-out" && f.category==="glide")).map(fleet => {
              const alreadyLoaded = fleet.skis.every(fs =>
                (test.skis||[]).some(s => s.id === fs.id)
              );
              return (
                <div key={fleet.id} style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", padding:"10px 12px", background:"var(--paper-2)",
                  borderRadius:8, marginBottom:6, border:"1.5px solid var(--rule)" }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:600, fontSize:14 }}>{fleet.name}</div>
                    <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginTop:2 }}>
                      {fleet.skis.map(s => s.id).join(" · ")}
                      {fleet.notes ? ` — ${fleet.notes}` : ""}
                    </div>
                    {/* Show ski details inline */}
                    {fleet.skis.some(s => s.make||s.flex||s.grind) && (
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:6 }}>
                        {fleet.skis.map(s => (
                          <div key={s.id} style={{ fontSize:11, background:"var(--paper-3)",
                            borderRadius:4, padding:"2px 8px" }}>
                            <span className="mono" style={{ fontWeight:700 }}>{s.id}</span>
                            {s.make && <span style={{ color:"var(--ink-mid)" }}> {s.make}</span>}
                            {s.flex && <span style={{ color:"var(--ink-faint)" }}> flex {s.flex}</span>}
                            {s.grind && <span style={{ color:"var(--ink-faint)" }}> {s.grind}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className={alreadyLoaded ? "btn-ghost" : "btn"}
                    style={{ fontSize:12, padding:"6px 14px", minHeight:34,
                      flexShrink:0, marginLeft:10,
                      opacity: alreadyLoaded ? 0.5 : 1 }}
                    disabled={alreadyLoaded}
                    onClick={() => {
                      // Import each ski that doesn't already exist in the test
                      const existing = new Set((test.skis||[]).map(s => s.id));
                      const toAdd = fleet.skis
                        .filter(fs => !existing.has(fs.id))
                        .map(fs => ({
                          id: fs.id,
                          product: "",
                          application: "",   // user fills in the wax applied
                          notes: "",
                          standing: "Active",
                          ratings: {},
                        }));
                      if (toAdd.length > 0) {
                        upd({ skis: [...(test.skis||[]), ...toAdd] });
                      }
                    }}>
                    {alreadyLoaded ? "✓ Loaded" : `Load ${fleet.skis.length} skis`}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, marginTop:4 }}>
          <Lbl style={{ marginBottom:0 }}>Registered Skis</Lbl>
          <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:13 }}>
            <input type="checkbox" checked={!!test.blindMode}
              onChange={e=>upd({blindMode:e.target.checked,blindRevealed:false})}
              style={{ width:16,height:16 }} />
            Blind Mode
          </label>
        </div>

        {(test.skis||[]).map(ski=>(
          editingId===ski.id
            ? <SkiEditInline key={ski.id} ski={ski} vocab={vocab}
                onSave={p=>saveEdit(ski.id,p)} onCancel={()=>setEditingId(null)}
                onPhotoSave={updatePhotos} teamCode={teamCode} eventId={eventId} />
            : <div key={ski.id} className="card" style={{ display:"flex", justifyContent:"space-between",
                alignItems:"center", padding:"10px 12px", marginBottom:6 }}>
                <div>
                  <span className="mono" style={{ fontSize:13, fontWeight:700 }}>{ski.id}</span>
                  {ski.product&&<span style={{ fontSize:13, marginLeft:8 }}>{ski.product}</span>}
                  {ski.application&&<span style={{ fontSize:12, color:"var(--ink-faint)", marginLeft:6 }}>{ski.application}</span>}
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={()=>setEditingId(ski.id)} className="btn-ghost"
                    style={{ fontSize:12, padding:"4px 10px", minHeight:30 }}>Edit</button>
                  <button onClick={()=>removeSki(ski.id)} className="btn-text"
                    style={{ fontSize:20, padding:"0 4px" }}>×</button>
                </div>
              </div>
        ))}

        <div style={{ background:"var(--paper-2)", borderRadius:8, padding:14, marginTop:8, border:"1.5px solid var(--rule)" }}>
          <Lbl>Add Ski</Lbl>
          {/* Quick-tap ID suggestions */}
          <div style={{ marginBottom:10 }}>
            <Lbl>Ski ID</Lbl>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:6 }}>
              {suggestedSkiIds(test.skis).map(id=>(
                <button key={id} onClick={()=>setNewId(id)}
                  className={newId===id?"btn":"btn-ghost"}
                  style={{ padding:"6px 14px", fontSize:14, fontWeight:700, minHeight:38,
                    fontFamily:"'SF Mono','Courier New',monospace", letterSpacing:"0.06em" }}>
                  {id}
                </button>
              ))}
            </div>
            <input className="inp mono" value={newId}
              onChange={e=>setNewId(e.target.value.toUpperCase())}
              placeholder={`or type custom (e.g. ${nextSkiId(test.skis)})`}
              style={{ fontSize:15, letterSpacing:"0.06em" }} />
          </div>
          <ACI label="Product" value={newProduct} onChange={setNewProduct}
            onCommit={v=>onVocabAdd?.("products",[v])}
            suggestions={vocab?.products||[]} placeholder="Wax product…" style={{ marginBottom:8 }} />
          <ACI label="Application" value={newApp} onChange={setNewApp}
            onCommit={v=>onVocabAdd?.("applications",[v])}
            suggestions={vocab?.applications||[]} placeholder="Iron temp, layers…" style={{ marginBottom:8 }} />
          <div style={{ display:"flex", gap:8 }}>
            <button className="btn" onClick={addSki} style={{ flex:1 }}>Add to Fleet</button>
            <button className="btn-ghost" onClick={addSki} style={{ flex:1 }}>Add Another</button>
          </div>
        </div>
      </div>}

      {/* ── RESULTS ── */}
      {tab==="results"&&<div>
        {!(test.skis?.length) ? <div style={{ color:"var(--ink-faint)", fontSize:14, paddingTop:16 }}>No skis registered.</div>
          : (test.skis||[]).sort((a,b)=>{
              const ord={Winner:0,"Runner-Up":1,Active:2,Eliminated:3};
              return (ord[a.standing]??2)-(ord[b.standing]??2);
            }).map(ski=><SkiCard key={ski.id} ski={ski} isGlide={isGlide}
              isBlind={isBlind} onRatingChange={updateRating} onPhotoSave={updatePhotos}
              teamCode={teamCode} eventId={eventId} />)}

        {/* ── BRACKET HISTORY ── */}
        {(test.rounds||[]).length > 0 && <>
          <Hr />
          <Lbl>Match History ({test.rounds.length} round{test.rounds.length!==1?"s":""})</Lbl>
          <div style={{ fontFamily:"'SF Mono','Courier New',monospace" }}>
            {(test.rounds||[]).map((r,i) => {
              const winner = r.winner ? (test.skis||[]).find(s=>s.id===r.winner) : null;
              const loser  = r.loser  ? (test.skis||[]).find(s=>s.id===r.loser)  : null;
              return (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8,
                  padding:"8px 0", borderBottom:"1px solid var(--rule)" }}>
                  <span className="mono" style={{ fontSize:10, color:"var(--ink-faint)",
                    width:28, flexShrink:0 }}>R{r.roundNum||i+1}</span>
                  {r.winner && (
                    <div style={{ display:"flex", alignItems:"center", gap:6, flex:1 }}>
                      <span style={{ fontSize:12, fontWeight:700, color:"var(--green)" }}>
                        {r.winner}
                      </span>
                      {!isBlind && winner?.product && (
                        <span style={{ fontSize:11, color:"var(--ink-mid)" }}>{winner.product}</span>
                      )}
                      <span style={{ fontSize:12, fontWeight:700, color:"var(--green)" }}>▲</span>
                    </div>
                  )}
                  {r.loser && (
                    <div style={{ display:"flex", alignItems:"center", gap:6, flex:1 }}>
                      <span style={{ fontSize:12, color:"var(--red)", opacity:0.7 }}>
                        {r.loser}
                      </span>
                      {!isBlind && loser?.product && (
                        <span style={{ fontSize:11, color:"var(--ink-faint)" }}>{loser.product}</span>
                      )}
                      <span style={{ fontSize:12, color:"var(--red)" }}>✕</span>
                    </div>
                  )}
                  {!r.winner && !r.loser && (
                    <span style={{ fontSize:12, color:"var(--ink-faint)" }}>Outcome not recorded</span>
                  )}
                </div>
              );
            })}
          </div>
        </>}
      </div>}

      {/* ── NOTES ── */}
      {tab==="notes"&&<div>
        <TA label="Test Notes" value={test.notes} onChange={v=>upd({notes:v})}
          placeholder="Conditions, timing, observations…" rows={5} />
      </div>}
    </div>

    {/* Snow + Air temp FABs — visible on tournament and glideout tabs */}
    {(tab==="tournament"||tab==="glideout")&&<>
      <SnowTempFAB readings={test.snowTemps||[]}
        onAdd={r=>upd({snowTemps:[...(test.snowTemps||[]),r]})}
        onDelete={i=>upd({snowTemps:(test.snowTemps||[]).filter((_,idx)=>idx!==i)})}
        useCelsius={useCelsius} onUnitToggle={onUnitToggle} />
      <AirTempFAB readings={test.airTemps||[]}
        onAdd={r=>upd({airTemps:[...(test.airTemps||[]),r]})}
        onDelete={i=>upd({airTemps:(test.airTemps||[]).filter((_,idx)=>idx!==i)})}
        useCelsius={useCelsius} onUnitToggle={onUnitToggle} />
    </>}

    {undoVisible&&undoStack.length>0&&<UndoToast message={undoStack[0].label}
      onUndo={doUndo} onDismiss={()=>setUndoVisible(false)} />}
  </div>;
}

// ─── SKI EDIT INLINE ─────────────────────────────────────────────────────────
function SkiEditInline({ ski, vocab, onSave, onCancel, onPhotoSave, teamCode, eventId }) {
  const [product,setProduct]       = useState(ski.product||"");
  const [application,setApplication] = useState(ski.application||"");
  const [notes,setNotes]           = useState(ski.notes||"");
  const [feelNotes,setFeelNotes]   = useState(ski.feelNotes||"");
  const [showPhotos,setShowPhotos] = useState(false);
  return (
    <div className="card" style={{ padding:14, marginBottom:6, border:"2px solid var(--ink)" }}>
      {showPhotos && onPhotoSave && (
        <PhotoSheet ski={ski} teamCode={teamCode} eventId={eventId}
          onSave={photos=>onPhotoSave(ski.id,photos)} onClose={()=>setShowPhotos(false)} />
      )}
      <ACI label="Product" value={product} onChange={setProduct} suggestions={vocab?.products||[]} />
      <ACI label="Application" value={application} onChange={setApplication} suggestions={vocab?.applications||[]} />
      <TA label="Notes" value={notes} onChange={setNotes} rows={2} />
      <TA label="Feel Notes" value={feelNotes} onChange={setFeelNotes} rows={2} />
      {ski.photos?.length > 0 && (
        <div style={{ marginBottom:12 }}>
          <Lbl>Photos ({ski.photos.length})</Lbl>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {ski.photos.map(p => (
              <img key={p.id} src={p.thumb} alt={p.caption||""}
                onClick={()=>setShowPhotos(true)}
                style={{ width:52, height:52, objectFit:"cover", borderRadius:4, cursor:"pointer" }} />
            ))}
          </div>
        </div>
      )}
      <div style={{ display:"flex", gap:8 }}>
        <button className="btn" style={{ flex:2 }} onClick={()=>onSave({product,application,notes,feelNotes})}>Save</button>
        <button className="btn-ghost" style={{ flex:1 }}
          onClick={()=>setShowPhotos(true)}>Photos</button>
        <button className="btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── SESSION VIEW ─────────────────────────────────────────────────────────────
function SessionView({ session, onUpdate, onBack, vocab, onVocabAdd, useCelsius, onUnitToggle, teamCode, eventId, fleets=[], allEvents=[], onPromoteEventWeather, activeTestId, onSetActiveTest }) {
  const [tab, setTab] = useState("tests");
  // activeTestId lifted to App — persists across navigation
  const setActiveTestId = onSetActiveTest || (() => {});
  const [creatingTest, setCreatingTest] = useState(false);
  const [newTestName, setNewTestName] = useState("");
  const [newTestCategory, setNewTestCategory] = useState("glide");
  const [newTestType, setNewTestType] = useState("");
  const [deadlinePickerTest, setDeadlinePickerTest] = useState(null);

  function upd(patch) { onUpdate({...session,...patch}); }
  function updateTest(updated) { upd({tests:(session.tests||[]).map(t=>t.id===updated.id?updated:t)}); }

  // Deadline alarms — manages timers for all tests in this session
  function handleSnooze(testId, newDeadline) {
    const t = (session.tests||[]).find(t=>t.id===testId);
    if (t) updateTest({ ...t, deadline: newDeadline });
  }
  const { alarmTest, dismissAlarm, snooze } = useDeadlines(session.tests, handleSnooze);

  if (activeTestId) {
    const test=(session.tests||[]).find(t=>t.id===activeTestId);
    if (!test) return null;
    return <TestView test={test} onUpdate={updateTest} onBack={()=>setActiveTestId(null)}
      vocab={vocab} onVocabAdd={onVocabAdd} useCelsius={useCelsius} onUnitToggle={onUnitToggle}
      teamCode={teamCode} eventId={eventId} fleets={fleets} />;
  }

  function createTest(cat, type) {
    const name=newTestName.trim()||(cat==="glide"?"Glide Test":cat==="glide-out"?"Glide Out Test":"Kick Test");
    const t={id:uid(),name,category:cat,type:type||"",skis:[],snowTemps:[],airTemps:[],notes:"",createdAt:nowStr()};
    upd({tests:[...(session.tests||[]),t]});
    setCreatingTest(false); setNewTestName(""); setNewTestCategory("glide"); setNewTestType("");
    setActiveTestId(t.id);
  }

  const TABS=[{id:"tests",label:"Tests"},{id:"conditions",label:"Conditions"},{id:"snowtemps",label:"Snow Temps"}];

  return <>
    {alarmTest && <AlarmModal test={alarmTest} onDismiss={dismissAlarm}
      onSnooze={(t,m)=>snooze(t,m)} />}
    {deadlinePickerTest && <DeadlinePicker test={deadlinePickerTest}
      onSave={patch=>updateTest({...deadlinePickerTest,...patch})}
      onClose={()=>setDeadlinePickerTest(null)} />}
    <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
    <div className="view-header">
      <BackBtn onClick={onBack} />
      <div style={{ textAlign:"center" }}>
        <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Session</div>
        <div style={{ fontSize:15, fontWeight:700 }}>{session.name}</div>
      </div>
      <SessionTimer startedAt={session.startedAt||session.createdAt} />
    </div>
    <div className="tab-bar">
      {TABS.map(t=><button key={t.id} className={`tab-btn${tab===t.id?" active":""}`}
        onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </div>
    <div style={{ padding:16 }}>

      {tab==="tests"&&<>
        <TI label="Session Name" value={session.name} onChange={v=>upd({name:v})} mic />
        <TA label="Notes" value={session.notes} onChange={v=>upd({notes:v})} rows={2} />
        <Hr />
        {(session.tests||[]).map(test=>{
          const winner=test.skis?.find(s=>s.standing==="Winner");
          const active=test.skis?.filter(s=>s.standing==="Active")||[];
          return <div key={test.id} className="card" style={{ marginBottom:8, overflow:"visible" }}>
            <div style={{ padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>{test.name||"Unnamed Test"}</div>
                <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginTop:2 }}>
                  {test.category} · {test.type} · {(test.skis||[]).length} skis
                  {test.testers ? ` · ${test.testers}` : ""}
                </div>
              </div>
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                {winner&&<span className="tag" style={{ color:"var(--green)", fontSize:9 }}>Winner</span>}
                {!winner&&active.length>0&&<span className="tag" style={{ color:"var(--amber)", fontSize:9 }}>Active</span>}
                {test.deadline && <CountdownBadge deadline={test.deadline} />}
                <button onClick={()=>setDeadlinePickerTest(test)} className="btn-ghost"
                  title="Set deadline" style={{ fontSize:14, padding:"6px 10px", minHeight:34 }}>⏱</button>
                <button onClick={()=>setActiveTestId(test.id)} className="btn"
                  style={{ fontSize:12, padding:"6px 14px", minHeight:34 }}>Open</button>
                <button title="Duplicate test (copies fleet setup, clears results)"
                  onClick={()=>{
                    const copy = copyTest(test);
                    upd({ tests:[...(session.tests||[]), copy] });
                  }}
                  className="btn-ghost" style={{ fontSize:12, padding:"6px 10px", minHeight:34 }}>
                  Copy
                </button>
                <button onClick={()=>upd({tests:(session.tests||[]).filter(t=>t.id!==test.id)})}
                  className="btn-text" style={{ fontSize:20 }}>×</button>
              </div>
            </div>
            {test.notes&&<div style={{ padding:"0 14px 10px", fontSize:12, color:"var(--ink-mid)", fontStyle:"italic" }}>{test.notes}</div>}
          </div>;
        })}

        {creatingTest
          ? <div style={{ background:"var(--paper-2)", borderRadius:8, padding:16,
              marginTop:8, border:"1.5px solid var(--rule)" }}>
              <Lbl>Quick Start</Lbl>
              {/* One-tap presets */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
                <button className="btn-ghost" style={{ padding:"14px 0", fontSize:14, fontWeight:600 }}
                  onClick={()=>createTest("glide","")}>Glide Test</button>
                <button className="btn-ghost" style={{ padding:"14px 0", fontSize:14, fontWeight:600 }}
                  onClick={()=>createTest("kick","")}>Kick Test</button>
                <button className="btn-ghost" style={{ padding:"14px 0", fontSize:14, fontWeight:600,
                  gridColumn:"1 / -1" }}
                  onClick={()=>createTest("glide-out","")}>Glide Out Test</button>
              </div>
              <Hr style={{ margin:"0 0 12px" }} />
              <Lbl>Or configure</Lbl>
              <TI label="Test Name" value={newTestName} onChange={setNewTestName}
                placeholder="e.g. Morning Glide" autoFocus style={{ marginBottom:8 }} />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
                <div>
                  <Lbl>Category</Lbl>
                  <select className="inp" value={newTestCategory}
                    onChange={e=>{ setNewTestCategory(e.target.value); setNewTestType(""); }}>
                    <option value="glide">Glide</option>
                    <option value="kick">Kick</option>
                    <option value="glide-out">Glide Out</option>
                  </select>
                </div>
                <div>
                  <Lbl>Type</Lbl>
                  <select className="inp" value={newTestType} onChange={e=>setNewTestType(e.target.value)}>
                    <option value="">— select —</option>
                    {(newTestCategory==="glide"||newTestCategory==="glide-out"
                        ? ["Topcoat","Paraffin","Hand structure","Grind"]
                        : ["Binder","Mid layer","Top layer","Full stack"]
                      ).map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn" style={{ flex:2 }} onClick={()=>createTest(newTestCategory,newTestType)}>Create Test</button>
                <button className="btn-ghost" style={{ flex:1 }} onClick={()=>setCreatingTest(false)}>Cancel</button>
              </div>
            </div>
          : <button className="btn-ghost" onClick={()=>setCreatingTest(true)}
              style={{ width:"100%", marginTop:8, padding:"14px 0", fontSize:14, fontWeight:600 }}>
              + New Test
            </button>
        }
      </>}

      {tab==="conditions"&&<div>
        <WeatherPanel weather={session.weather||{}} onChange={w=>upd({weather:w})}
          vocab={vocab} onVocabAdd={onVocabAdd} useCelsius={useCelsius} onUnitToggle={onUnitToggle}
          onPromoteWeather={onPromoteEventWeather ? ()=>onPromoteEventWeather(session.weather||{}) : null} />
        <PredictPanel allEvents={allEvents} sessionWeather={session.weather}
          useCelsius={useCelsius} />
      </div>}

      {tab==="snowtemps"&&<div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <Lbl style={{ marginBottom:0 }}>Snow Temperature Log</Lbl>
          <UnitPill useCelsius={useCelsius} onChange={onUnitToggle} />
        </div>
        {(()=>{
          // Aggregate snow temps from all tests in this session
          const allReadings = (session.tests||[]).flatMap(t=>
            (t.snowTemps||[]).map(r=>({...r, testName:t.name||""}))
          ).sort((a,b)=>new Date(b.ts)-new Date(a.ts));
          if (allReadings.length===0) return (
            <div style={{ color:"var(--ink-faint)", fontSize:13, padding:"8px 0" }}>
              No readings yet. Use the ❄ button in a test to log snow temp.
            </div>
          );
          return allReadings.map((r,i)=>(
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"10px 0", borderBottom:"1px solid var(--rule)" }}>
              <span style={{ fontSize:17, fontWeight:600 }}>{dispTemp(r.tempF,useCelsius)}</span>
              <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>{r.testName}</span>
              <span className="mono" style={{ fontSize:12, color:"var(--ink-faint)" }}>{fmtTime(r.ts)}</span>
            </div>
          ));
        })()}
      </div>}
    </div>
  </div>
  </>;
}
function EventView({ event, onUpdate, onBack, onDelete, vocab, onVocabAdd, allEvents, useCelsius, onUnitToggle, teamCode, fleets=[], activeSessionId, onSetActiveSession, activeTestId, onSetActiveTest }) {
  const [tab, setTab] = useState("sessions");
  // activeSessionId is lifted to App for persistence across navigation
  const setActiveSessionId = onSetActiveSession || (() => {});

  function upd(patch) { onUpdate({...event,...patch}); }
  function updateSession(updated) { upd({sessions:(event.sessions||[]).map(s=>s.id===updated.id?updated:s)}); }

  if (activeSessionId) {
    const sess=(event.sessions||[]).find(s=>s.id===activeSessionId);
    if (!sess) return null;
    return <SessionView session={sess} onUpdate={updateSession}
      onBack={()=>{ onSetActiveTest?.(null); setActiveSessionId(null); }}
      activeTestId={activeTestId} onSetActiveTest={onSetActiveTest}
      vocab={vocab} onVocabAdd={onVocabAdd} useCelsius={useCelsius} onUnitToggle={onUnitToggle}
      teamCode={teamCode} eventId={event.id} fleets={fleets} allEvents={allEvents}
      onPromoteEventWeather={w=>onUpdate({...event, weather:{...event.weather, ...w}})} />;
  }

  function addSession() {
    const s={id:uid(),name:`Session ${(event.sessions||[]).length+1}`,tests:[],snowTemps:[],createdAt:nowStr(),startedAt:nowStr()};
    upd({sessions:[...(event.sessions||[]),s]});
    setActiveSessionId(s.id);
  }

  const TABS=[
    {id:"sessions",label:"Sessions"},
    {id:"raceday",label:"Race Day"},
    {id:"trend",label:"Trend"},
    {id:"compare",label:"Compare"},
    {id:"info",label:"Info"},
    {id:"export",label:"Export"},
  ];

  return <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
    <div className="view-header">
      <BackBtn onClick={onBack} />
      <div style={{ textAlign:"center", maxWidth:200 }}>
        <div style={{ fontSize:15, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{event.name}</div>
        {event.location&&<div className="mono" style={{ fontSize:10, color:"var(--ink-faint)" }}>{event.location}</div>}
      </div>
      <button onClick={()=>{ if(window.confirm("Delete this event?")) onDelete(event.id); }}
        className="btn-text" style={{ color:"var(--red)", fontSize:13 }}>Delete</button>
    </div>
    <div className="tab-bar">
      {TABS.map(t=><button key={t.id} className={`tab-btn${tab===t.id?" active":""}`}
        onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </div>
    <div style={{ padding:16, paddingBottom:40 }}>

      {tab==="sessions"&&<>
        {(event.sessions||[]).map(sess=>{
          const tc=(sess.tests||[]).length;
          const wc=(sess.tests||[]).filter(t=>t.skis?.some(s=>s.standing==="Winner")).length;
          return <div key={sess.id} className="card" style={{ marginBottom:8, overflow:"visible" }}>
            <div style={{ padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>{sess.name}</div>
                <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginTop:2 }}>
                  {tc} test{tc!==1?"s":""} · {wc} winner{wc!==1?"s":""}
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={()=>setActiveSessionId(sess.id)} className="btn"
                  style={{ fontSize:12, padding:"6px 14px", minHeight:34 }}>Open</button>
                <button title="Duplicate session (copies fleet setup, clears results)"
                  onClick={()=>{
                    const copy = copySession(sess, event.sessions||[]);
                    upd({ sessions:[...(event.sessions||[]), copy] });
                  }}
                  className="btn-ghost" style={{ fontSize:12, padding:"6px 10px", minHeight:34 }}>
                  Copy
                </button>
                <button onClick={()=>upd({sessions:(event.sessions||[]).filter(s=>s.id!==sess.id)})}
                  className="btn-text" style={{ fontSize:20 }}>×</button>
              </div>
            </div>
          </div>;
        })}
        <button className="btn-ghost" onClick={addSession}
          style={{ width:"100%", marginTop:8, padding:"14px 0", fontSize:14, fontWeight:600 }}>
          + New Session
        </button>
        <Hr />
        <Lbl>Event Details</Lbl>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          <TI label="Event Name" value={event.name} onChange={v=>upd({name:v})} style={{ marginBottom:0 }} />
          <TI label="Race Name" value={event.raceName} onChange={v=>upd({raceName:v})} style={{ marginBottom:0 }} />
          <TI label="Location" value={event.location} onChange={v=>upd({location:v})} style={{ marginBottom:0 }} />
          <TI label="Date" value={event.date} onChange={v=>upd({date:v})} style={{ marginBottom:0 }} />
        </div>
        <TA label="Notes" value={event.notes} onChange={v=>upd({notes:v})} rows={3} style={{ marginTop:12 }} />
      </>}

      {tab==="raceday"&&<RaceDaySummary event={event} useCelsius={useCelsius} />}
      {tab==="trend"&&<ConditionsTrend events={[event]} useCelsius={useCelsius} />}
      {tab==="compare"&&<CrossEventComparison events={allEvents} useCelsius={useCelsius} />}
      {tab==="info"&&<div>
        <TI label="Event Name" value={event.name} onChange={v=>upd({name:v})} />
        <TI label="Race Name" value={event.raceName} onChange={v=>upd({raceName:v})} />
        <TI label="Location" value={event.location} onChange={v=>upd({location:v})} />
        <TI label="Date" value={event.date} onChange={v=>upd({date:v})} />
        <TA label="Notes" value={event.notes} onChange={v=>upd({notes:v})} rows={4} />
        <Hr />
        <Lbl>Race Wax Selection</Lbl>
        <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8, lineHeight:1.5 }}>
          Record which wax was actually applied for racing — this may differ from the test winner based on projected conditions.
        </div>
        <TI label="Selected race wax" value={event.raceWaxChoice||""}
          onChange={v=>upd({raceWaxChoice:v})}
          placeholder="e.g. Swix HF10, Vauhti LF Blue…" />
        <TA label="Reason for selection" value={event.raceWaxReason||""}
          onChange={v=>upd({raceWaxReason:v})} rows={3}
          placeholder="e.g. Forecast softening to -2°C by race time, chose test 2nd-place for better wet glide…" />
        <Hr />
        <TA label="Post-race athlete feedback" value={event.raceFeedback||""}
          onChange={v=>upd({raceFeedback:v})} rows={3}
          placeholder="How did the race wax perform? Athlete feedback, start order notes…" />
      </div>}
      {tab==="export"&&<ExportPanel event={event} />}
    </div>
  </div>;
}


// ─── HOME ─────────────────────────────────────────────────────────────────────
function Home({ events, onNew, onOpen, useCelsius, teamCode, onRestore, onProducts, syncStatus, online }) {
  const sorted=[...events].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const [showNewModal, setShowNewModal] = useState(false);
  const lastEvent = sorted[0] || null;
  return <div style={{ minHeight:"100vh", background:"var(--paper)" }}>
    <div style={{ padding:"20px 16px 12px", borderBottom:"1.5px solid var(--rule)" }}>
      <div className="mono" style={{ fontSize:10, fontWeight:600, letterSpacing:"0.12em",
        textTransform:"uppercase", color:"var(--ink-faint)", marginBottom:4 }}>WaxLab</div>
      <div style={{ fontSize:26, fontWeight:800, marginBottom:12 }}>Events</div>
      <div style={{ display:"flex", gap:8 }}>
        <button className="btn" style={{ flex:2, fontSize:14 }} onClick={()=>setShowNewModal(true)}>+ New Event</button>
        <button className="btn-ghost" style={{ flex:1, fontSize:13 }} onClick={onProducts}>Library</button>
      </div>
    </div>
    <SyncStatusBanner syncStatus={syncStatus} online={online} />
    <div style={{ padding:16 }}>
      {sorted.length===0
        ? <div style={{ textAlign:"center", padding:"48px 0", color:"var(--ink-faint)", fontSize:15 }}>
            No events yet.<br/>Tap New Event to get started.
          </div>
        : sorted.map(ev=>{
            const w=ev.weather;
            const winCount=(ev.sessions||[]).flatMap(s=>s.tests||[]).filter(t=>t.skis?.some(s=>s.standing==="Winner")).length;
            const testCount=(ev.sessions||[]).flatMap(s=>s.tests||[]).length;
            return <div key={ev.id} className="card" onClick={()=>onOpen(ev.id)}
              style={{ padding:"14px 16px", marginBottom:10, cursor:"pointer" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1, marginRight:12 }}>
                  <div style={{ fontWeight:700, fontSize:16 }}>{ev.name}</div>
                  {ev.raceName&&<div style={{ fontSize:13, color:"var(--ink-mid)", marginTop:1 }}>{ev.raceName}</div>}
                  {ev.location&&<div className="mono" style={{ fontSize:11, color:"var(--ink-faint)", marginTop:2 }}>{ev.location}</div>}
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>{fmtDate(ev.date||ev.createdAt)}</div>
                  {w?.airTempF!=null&&<div style={{ fontSize:13, fontWeight:600, marginTop:2 }}>{dispTemp(w.airTempF,useCelsius)}</div>}
                  {w?.sky&&<div style={{ fontSize:11, color:"var(--ink-mid)" }}>{w.sky}</div>}
                </div>
              </div>
              {(testCount>0||winCount>0)&&<div style={{ display:"flex", gap:12, marginTop:8, paddingTop:8,
                borderTop:"1px solid var(--rule)" }}>
                <span className="mono" style={{ fontSize:11, color:"var(--ink-faint)" }}>
                  {testCount} test{testCount!==1?"s":""}
                </span>
                {winCount>0&&<span className="mono" style={{ fontSize:11, color:"var(--green)", fontWeight:600 }}>
                  {winCount} winner{winCount!==1?"s":""}
                </span>}
              </div>}
            </div>;
          })
      }
      <BackupRestore teamCode={teamCode} events={events} onRestore={onRestore} />
    </div>

    {/* New event modal — offer fleet continuity */}
    {showNewModal && (
      <div className="snow-modal-backdrop" onClick={e=>{ if(e.target===e.currentTarget) setShowNewModal(false); }}>
        <div className="snow-modal">
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <span style={{ fontSize:17, fontWeight:700 }}>New Event</span>
            <button onClick={()=>setShowNewModal(false)} className="btn-text" style={{ fontSize:22 }}>×</button>
          </div>
          {lastEvent ? (<>
            <div style={{ fontSize:13, color:"var(--ink-mid)", marginBottom:16, lineHeight:1.6 }}>
              Copy the session and fleet setup from your last event, or start blank.
              Test results will not be copied.
            </div>
            <button className="btn" style={{ width:"100%", marginBottom:8, textAlign:"left",
              padding:"12px 16px", fontSize:13 }}
              onClick={()=>{ setShowNewModal(false); onNew({ copyFrom: lastEvent }); }}>
              <div style={{ fontWeight:700, marginBottom:2 }}>↪ Copy from: {lastEvent.name}</div>
              <div style={{ fontWeight:400, fontSize:11, opacity:0.8 }}>
                {(lastEvent.sessions||[]).length} session{(lastEvent.sessions||[]).length!==1?"s":""}
                {" · "}{(lastEvent.sessions||[]).flatMap(s=>s.tests||[]).length} tests
                {" · fleet setup preserved"}
              </div>
            </button>
            <button className="btn-ghost" style={{ width:"100%", fontSize:13, padding:"10px 0" }}
              onClick={()=>{ setShowNewModal(false); onNew({}); }}>
              Start blank
            </button>
          </>) : (
            // No previous events — just create
            <button className="btn" style={{ width:"100%", fontSize:14 }}
              onClick={()=>{ setShowNewModal(false); onNew({}); }}>
              Create New Event
            </button>
          )}
        </div>
      </div>
    )}
  </div>;
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
const STEPS=[
  {icon:"❄",title:"Welcome to WaxLab",body:"A wax testing app for Nordic ski racing staff. Works on any phone. The lead sets up events — the whole team collaborates and sees results live."},
  {icon:"📋",title:"Event → Session → Test",body:"An Event is a race day. Sessions are time blocks. Each Session holds concurrent Tests — glide and kick can run simultaneously."},
  {icon:"🏆",title:"Running a tournament",body:"Add skis in Fleet, then head to Tournament. Advance or Eliminate skis head-to-head. Swipe right to advance, left to eliminate. Rate skis right on the card."},
  {icon:"🙈",title:"Blind testing",body:"Enable Blind Mode in Fleet. Testers see only ski IDs — no product names. Reveal after the winner is declared to eliminate bias."},
  {icon:"📊",title:"Conditions & trends",body:"Log weather via GPS or venue search. Snow temp is always one tap away with the ❄ button. Trend tab shows how conditions changed across sessions."},
  {icon:"🏅",title:"Race Day summary",body:"The Race Day tab shows all winners with conditions and ratings — ready to read in the wax cabin or print and share before the start."},
  {icon:"💾",title:"Autocomplete & export",body:"Product names autocomplete from a shared global dictionary. Export any event as Excel. Toggle °F / °C anywhere with the unit pill."},
];
function OnboardingOverlay({ onDone }) {
  const [step,setStep]=useState(0);
  const s=STEPS[step];
  return <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", zIndex:1000,
    display:"flex", alignItems:"flex-end", justifyContent:"center", padding:"0 0 0" }}>
    <div style={{ background:"var(--paper)", width:"100%", maxWidth:480, borderRadius:"16px 16px 0 0", padding:"28px 24px 40px" }}>
      <div style={{ fontSize:44, textAlign:"center", marginBottom:12 }}>{s.icon}</div>
      <div style={{ fontSize:20, fontWeight:800, textAlign:"center", marginBottom:8 }}>{s.title}</div>
      <div style={{ fontSize:15, color:"var(--ink-mid)", lineHeight:1.65, textAlign:"center", marginBottom:24 }}>{s.body}</div>
      <div style={{ display:"flex", justifyContent:"center", gap:6, marginBottom:20 }}>
        {STEPS.map((_,i)=><div key={i} style={{ width:7, height:7, borderRadius:"50%",
          background:i===step?"var(--ink)":"var(--rule)", transition:"background 0.2s" }} />)}
      </div>
      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
        {step>0&&<button className="btn-ghost" style={{ flex:1 }} onClick={()=>setStep(s=>s-1)}>Back</button>}
        {step<STEPS.length-1
          ? <button className="btn" style={{ flex:2 }} onClick={()=>setStep(s=>s+1)}>Next</button>
          : <button className="btn" style={{ flex:2 }} onClick={onDone}>Get Started</button>}
        <button className="btn-text" onClick={onDone} style={{ padding:"8px 12px" }}>Skip</button>
      </div>
    </div>
  </div>;
}

// ─── TEAM SELECTOR ────────────────────────────────────────────────────────────
function getHashTeam()        { return window.location.hash.replace("#","").toUpperCase()||null; }
function setHashTeam(c)       { window.location.hash=c; }
function getRecentTeams()     { return lsGet("waxlab:recent_teams")||[]; }
function addRecentTeam(c)     { const r=[c,...getRecentTeams().filter(t=>t!==c)].slice(0,5); lsSet("waxlab:recent_teams",r); }
function normalise(s)         { return s.toUpperCase().replace(/[^A-Z0-9-]/g,""); }

function TeamSelector({ onJoin }) {
  const [code,setCode]=useState(getHashTeam()||"");
  const [showHelp,setShowHelp]=useState(false);
  const recents=getRecentTeams();
  function join(c) { const n=normalise(c.trim()); if(!n) return; addRecentTeam(n); setHashTeam(n); onJoin(n); }
  return <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column",
    justifyContent:"center", alignItems:"center", background:"var(--paper)", padding:24 }}>
    {showHelp&&<OnboardingOverlay onDone={()=>setShowHelp(false)} />}
    <div style={{ width:"100%", maxWidth:360 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
        <span className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:"0.12em",
          textTransform:"uppercase", color:"var(--ink-faint)" }}>WaxLab</span>
        <button onClick={()=>setShowHelp(true)} className="btn-ghost"
          style={{ fontSize:12, padding:"6px 12px", minHeight:32 }}>? How it works</button>
      </div>
      <div style={{ fontSize:30, fontWeight:800, marginBottom:4 }}>Wax Testing</div>
      <div style={{ fontSize:14, color:"var(--ink-mid)", marginBottom:28, lineHeight:1.5 }}>
        Nordic ski wax testing for racing staff.
      </div>
      <Lbl>Team Code</Lbl>
      <div style={{ fontSize:12, color:"var(--ink-faint)", marginBottom:8, lineHeight:1.5 }}>
        Everyone on your team enters the same code to share events and tests live.
      </div>
      <input className="inp mono" value={code} onChange={e=>setCode(e.target.value.toUpperCase())}
        onKeyDown={e=>e.key==="Enter"&&join(code)} placeholder="e.g. EAST, CRAFTSBURY"
        style={{ marginBottom:8, letterSpacing:"0.08em", fontSize:18 }} />
      <button className="btn" onClick={()=>join(code)} style={{ width:"100%", marginBottom:24, fontSize:15 }}>
        Join Team →
      </button>
      {recents.length>0&&<>
        <Lbl>Recent</Lbl>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {recents.map(r=><button key={r} onClick={()=>join(r)} className="mono btn-ghost"
            style={{ textAlign:"left", fontSize:15, letterSpacing:"0.06em", fontWeight:600 }}>
            {r}
          </button>)}
        </div>
      </>}
    </div>
  </div>;
}

// ─── TEAM BAR ─────────────────────────────────────────────────────────────────
function TeamBar({ teamCode, syncStatus, darkMode, onToggleDark, onLeave, useCelsius, onUnitToggle, onFleets }) {
  const [copied,setCopied]=useState(false);
  const statusColor=syncStatus==="saving"?"var(--amber)":syncStatus==="error"?"var(--red)":"var(--green)";
  const statusDot=syncStatus==="saving"?"-":syncStatus==="error"?"!":"*";
  function copy() { navigator.clipboard.writeText(window.location.href).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }); }
  return <div className="team-bar no-print">
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <span className="mono" style={{ fontSize:12, fontWeight:700, letterSpacing:"0.1em" }}>{teamCode}</span>
      {supabaseConfigured&&<span className="mono"
          style={{ fontSize:10, color:statusColor, display:"flex", alignItems:"center", gap:3 }}>
          {statusDot}
          <span>{syncStatus==="saving"?"saving…":syncStatus==="error"?"sync error":syncStatus==="saved"?"saved":""}</span>
        </span>}
      {!supabaseConfigured&&<span className="mono" style={{ fontSize:10, color:"var(--ink-faint)" }}>local only</span>}
    </div>
    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
      <UnitPill useCelsius={useCelsius} onChange={onUnitToggle} />
      <button onClick={onToggleDark} className="btn-ghost"
        style={{ fontSize:12, padding:"4px 10px", minHeight:30 }}>{darkMode?"Light":"Dark"}</button>
      <button onClick={onFleets} className="btn-ghost"
        style={{ fontSize:12, padding:"4px 10px", minHeight:30 }}>Fleets</button>
      <button onClick={copy} className="btn-ghost"
        style={{ fontSize:12, padding:"4px 10px", minHeight:30 }}>{copied?"✓":"Share"}</button>
      <button onClick={onLeave} className="btn-text" style={{ fontSize:12 }}>Switch</button>
    </div>
  </div>;
}

// ─── APP ──────────────────────────────────────────────────────────────────────
function App() {
  const [teamCode,setTeamCode]=useState(null);
  const [events,setEvents]=useState([]);
  const [vocab,setVocab]=useState({});
  const [fleets,setFleets]=useState([]);
  const [view,setView]=useState("home");
  const [activeId,setActiveId]=useState(null);
  // Lifted nav state — persists when user navigates to Fleets/Library and back
  const [activeSessionId,setActiveSessionId]=useState(null);
  const [activeTestId,setActiveTestId]=useState(null);
  const [loading,setLoading]=useState(false);
  const [showOnboard,setShowOnboard]=useState(false);
  const [syncStatus,setSyncStatus]=useState("idle");
  const [allEventsGlobal,setAllEventsGlobal]=useState([]); // historical imports only
  // Live prediction pool = current team events + historical imports, always fresh
  const allEventsForPrediction = useMemo(() => {
    const liveIds = new Set(events.map(e=>e.id));
    const historical = allEventsGlobal.filter(e=>!liveIds.has(e.id));
    return [...events, ...historical];
  }, [events, allEventsGlobal]);
  const [darkMode,setDarkMode]=useState(()=>lsGet("waxlab:darkmode")||false);
  const [useCelsius,setUseCelsius]=useState(()=>lsGet("waxlab:celsius")||false);
  const online=useOnlineStatus();

  useEffect(()=>{ applyTheme(darkMode); lsSet("waxlab:darkmode",darkMode); },[darkMode]);
  useEffect(()=>{ lsSet("waxlab:celsius",useCelsius); },[useCelsius]);
  useEffect(()=>{
    if(!document.getElementById("waxlab-css")) {
      const el=document.createElement("style"); el.id="waxlab-css"; el.textContent=GLOBAL_CSS;
      document.head.appendChild(el);
    }
  },[]);
  useEffect(()=>{ const h=getHashTeam(); if(h) joinTeam(h); },[]);

  async function joinTeam(code) {
    setLoading(true); setTeamCode(code); setView("home");
    const [evs,voc,fls,allEvs]=await Promise.all([loadTeamEvents(code),loadVocab(),loadFleets(code),loadAllEvents()]);
    setEvents(evs||[]); setVocab(voc||{}); setFleets(fls||[]); setAllEventsGlobal(allEvs||[]);
    if (!lsGet(`waxlab:seen:${code}`)) { setShowOnboard(true); lsSet(`waxlab:seen:${code}`,true); }
    setLoading(false);
    return subscribeToTeam(code,
      change=>{ if(change.type==="delete") setEvents(p=>p.filter(e=>e.id!==change.id));
        else {
          // Skip realtime echo if we have un-flushed local edits for this event.
          // Our local version is newer than what just arrived from the DB.
          if (pendingWrites.current.has(change.event?.id)) return;
          setEvents(p=>p.find(e=>e.id===change.event?.id)?p.map(e=>e.id===change.event.id?change.event:e):[...p,change.event]);
        } },
      (cat,terms)=>setVocab(p=>({...p,[cat]:terms})),
      updatedFleets=>setFleets(updatedFleets)
    );
  }
  function leaveTeam() { window.location.hash=""; setTeamCode(null); }

  // Debounce DB writes: update local state immediately, flush to DB after 900ms idle.
  // pendingWrites: event IDs with local edits not yet confirmed by DB.
  // Realtime echos for these IDs are suppressed to prevent stale overwrites.
  const persistTimers = useRef({});
  const pendingWrites = useRef(new Set());
  const persist = useCallback((event) => {
    // Optimistic local update — instant, no lag
    setEvents(p => p.find(e => e.id === event.id)
      ? p.map(e => e.id === event.id ? event : e)
      : [...p, event]);
    // Block realtime echos for this event until the write confirms
    pendingWrites.current.add(event.id);
    clearTimeout(persistTimers.current[event.id]);
    setSyncStatus("saving");
    persistTimers.current[event.id] = setTimeout(async () => {
      // Retry up to 3 times (handles brief network drops)
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
        ok = await saveEvent(teamCode, event);
      }
      pendingWrites.current.delete(event.id);
      setSyncStatus(ok ? "saved" : "error");
      if (ok) setTimeout(() => setSyncStatus("idle"), 2000);
    }, 900);
  }, [teamCode]);

  async function createEvent(opts={}) {
    const copyFrom = opts.copyFrom || null;
    let sessions = [];
    if (copyFrom) {
      // Carry over session structure + fleet setup, clear all results
      sessions = (copyFrom.sessions||[]).map(sess => ({
        ...copySession(sess, []),
        name: sess.name,  // keep original name (not "(copy)")
      }));
    }
    const ev = { id:uid(), name:"New Event", raceName:"", location:"",
      date:new Date().toISOString().slice(0,10),
      sessions, weather:{}, notes:"", createdAt:nowStr() };
    await persist(ev);
    setActiveSessionId(null); setActiveTestId(null);
    setActiveId(ev.id);
    setView("event");
  }
  async function updateEvent(ev) { await persist(ev); }
  async function doDeleteEvent(id) { await deleteEventDB(teamCode,id); setEvents(p=>p.filter(e=>e.id!==id)); setView("home"); }

  function doRestore(importedEvents) {
    setEvents(prev => {
      const ids = new Set(prev.map(e=>e.id));
      const merged = [...prev, ...importedEvents.filter(e=>!ids.has(e.id))];
      merged.forEach(ev => saveEvent(teamCode, ev));
      return merged;
    });
  }

  function doImportHistory(newEvents) {
    const existing = loadHistoricalEvents();
    const ids = new Set(existing.map(e=>e.id));
    const merged = [...existing, ...newEvents.filter(e=>!ids.has(e.id))];
    saveHistoricalEvents(merged);
    setAllEventsGlobal(prev => {
      const prevIds = new Set(prev.map(e=>e.id));
      return [...prev, ...newEvents.filter(e=>!prevIds.has(e.id))];
    });
  }

  const toggleUnit=useCallback(v=>setUseCelsius(v),[]);
  const addVocab=useCallback(async(category,terms)=>{
    const cleaned=terms.map(t=>t.trim()).filter(Boolean);
    if(!cleaned.length) return;
    setVocab(p=>({...p,[category]:[...new Set([...(p[category]||[]),...cleaned])].sort()}));
    await addVocabTerms(category,cleaned);
  },[]);


  if (!teamCode) return <TeamSelector onJoin={joinTeam} />;
  if (loading) return <div style={{ display:"flex",alignItems:"center",justifyContent:"center",
    height:"100vh",fontSize:14,color:"var(--ink-faint)" }}>Loading…</div>;

  const activeEvent=events.find(e=>e.id===activeId);
  const bar=<TeamBar teamCode={teamCode} syncStatus={syncStatus} darkMode={darkMode}
    onToggleDark={()=>setDarkMode(d=>!d)} onLeave={leaveTeam}
    useCelsius={useCelsius} onUnitToggle={toggleUnit}
    onFleets={()=>setView("fleets")} />;

  function wrap(content) {
    return <div>
      {showOnboard&&<OnboardingOverlay onDone={()=>setShowOnboard(false)} />}
      {!online&&<div className="offline-bar">⚠ Offline — changes saved locally</div>}
      {bar}
      {content}
    </div>;
  }

  if (view==="event"&&activeEvent)
    return wrap(<EventView event={activeEvent} onUpdate={updateEvent}
      onBack={()=>{ setActiveTestId(null); setActiveSessionId(null); setView("home"); }}
      activeSessionId={activeSessionId} onSetActiveSession={setActiveSessionId}
      activeTestId={activeTestId} onSetActiveTest={setActiveTestId}
      onDelete={doDeleteEvent} vocab={vocab} onVocabAdd={addVocab} allEvents={allEventsForPrediction}
      useCelsius={useCelsius} onUnitToggle={toggleUnit} teamCode={teamCode} fleets={fleets} />);



  if (view==="fleets")
    return wrap(<FleetRegistryView teamCode={teamCode} fleets={fleets}
      onSave={async updated => { setFleets(updated); await saveFleets(teamCode, updated); }}
      onBack={()=>setView("home")} />);

    if (view==="library")
    return wrap(<ProductLibrary allEvents={allEventsForPrediction} useCelsius={useCelsius}
      onBack={()=>setView("home")} onImportHistory={()=>setView("import-history")} />);

  if (view==="import-history")
    return wrap(<HistoricalImport onImport={doImportHistory}
      onBack={()=>setView("library")} />);

  return wrap(<Home events={events} onNew={createEvent}
    onOpen={id=>{ setActiveSessionId(null); setActiveTestId(null); setActiveId(id); setView("event"); }}
    useCelsius={useCelsius} teamCode={teamCode}
    onRestore={doRestore} onProducts={()=>setView("library")}
    syncStatus={syncStatus} online={online} />);
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
