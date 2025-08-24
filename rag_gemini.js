// rag_gemini.js
// -----------------------------------------------------------------------------
// RAG minimal : Ingestion PDF + Embeddings Gemini + recherche cosine (JSONL)
// -----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const DATA_DIR = process.env.RAG_DATA_DIR || path.join(process.cwd(), 'data');
const IDX = path.join(DATA_DIR, 'index.jsonl');
const DOCS = path.join(DATA_DIR, 'docs.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(IDX)) fs.writeFileSync(IDX, '');
  if (!fs.existsSync(DOCS)) fs.writeFileSync(DOCS, JSON.stringify({ docs: [] }, null, 2));
}
function safeReadJSON(fp, fallback) { try { return JSON.parse(fs.readFileSync(fp,'utf8')); } catch { return fallback; } }
function* iterIndex() {
  ensureStore();
  const lines = (fs.readFileSync(IDX,'utf8')||'').split('\n');
  for (const line of lines) { if (!line.trim()) continue; try { yield JSON.parse(line); } catch {} }
}
function appendIndex(recs) { ensureStore(); fs.appendFileSync(IDX, recs.map(r=>JSON.stringify(r)).join('\n')+'\n'); }
function cleanText(s){ return (s||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }
function splitText(t,size=1400,overlap=220){ const x=cleanText(t); if(!x) return []; const out=[]; for(let i=0;i<x.length;i+=size-overlap){ const p=x.slice(i, Math.min(x.length, i+size)).trim(); if(p) out.push(p);} return out; }
function norm(v){let s=0;for(const x of v)s+=x*x;return Math.sqrt(s)||1e-12;}
function cosine(a,b){const n=Math.min(a.length,b.length);let d=0;for(let i=0;i<n;i++)d+=a[i]*b[i];return d/(norm(a)*norm(b));}

let _ai=null;
async function getGemini(){ if(_ai) return _ai; const { GoogleGenAI } = await import('@google/genai'); _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); return _ai; }
async function embedAll(texts, dim=768){
  if (!Array.isArray(texts) || !texts.length) return [];
  const ai = await getGemini();
  const res = await ai.models.embedContent({ model:'gemini-embedding-001', contents: texts, config:{ outputDimensionality: dim } });
  if (res.embeddings?.length) return res.embeddings.map(e=>e.values);
  if (res.embedding?.values) return [res.embedding.values];
  throw new Error('Réponse embeddings non reconnue');
}

async function ingestPdfBuffer(name, buf){
  ensureStore();
  if (!Buffer.isBuffer(buf)) throw new Error('ingestPdfBuffer attend un Buffer');
  const parsed = await pdfParse(buf);
  const text = cleanText(parsed.text||'');
  if (!text) return { file:name, added:0, chunks:0 };

  const chunks = splitText(text, 1400, 220);
  if (!chunks.length) return { file:name, added:0, chunks:0 };

  const embs = await embedAll(chunks, 768);
  const ts = Date.now();
  const recs = chunks.map((t,i)=>({ id:`${ts}_${i}`, doc:name, chunkIndex:i, text:t, embedding: embs[i] }));
  appendIndex(recs);

  const docs = safeReadJSON(DOCS, { docs: [] });
  if (!docs.docs.find(d=>d.name===name)) { docs.docs.push({ name, size: buf.length, createdAt: new Date().toISOString() }); fs.writeFileSync(DOCS, JSON.stringify(docs, null, 2)); }
  return { file:name, added: recs.length, chunks: chunks.length };
}

async function ingestPdfUrl(url){
  const fetch = (await import('node-fetch')).default;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch PDF échoué: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const name = (url.split('/').pop()||`doc_${Date.now()}.pdf`).split('?')[0];
  return ingestPdfBuffer(name, buf);
}

async function search(query, topK=8){
  if (!query?.trim()) return { context:'', sources:[], hits:[] };
  const [qemb] = await embedAll([query.trim()], 768);
  const hits = [];
  for (const rec of iterIndex()) { try { hits.push({ score: cosine(qemb, rec.embedding), ...rec }); } catch {} }
  hits.sort((a,b)=>b.score-a.score);
  const top = hits.slice(0, topK);
  const context = top.map(h=>`【${h.doc} · #${h.chunkIndex} · ${h.score.toFixed(3)}】\n${h.text}`).join('\n---\n');
  const sources = [...new Set(top.map(h=>h.doc))];
  return { context, sources, hits: top };
}

module.exports = { ingestPdfBuffer, ingestPdfUrl, search };
