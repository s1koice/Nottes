// Простое приложение заметок с опциональной синхронизацией через Supabase.
// Если рядом с index.html есть config.json с SUPABASE_URL/ANON_KEY — используем облако.
// Если нет — всё хранится локально (IndexedDB) и тоже работает.

let supabase = null;
let useCloud = false;
let userId = 'public-user'; // можно поменять после добавления Auth

async function loadConfig(){
  try {
    const cfg = await fetch('./config.json').then(r=>r.json());
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = cfg;
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      useCloud = true;
    }
  } catch { useCloud = false; }
}
await loadConfig();

// ---------- IndexedDB (локально) ----------
let idb;
function idbInit(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open('notes-lite', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    };
    req.onsuccess = () => { idb = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
await idbInit();

async function localList(){
  return new Promise(res=>{
    const tx = idb.transaction('notes','readonly');
    const st = tx.objectStore('notes');
    const req = st.getAll();
    req.onsuccess = () => res(req.result.sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)));
  });
}
async function localPut(n){
  return new Promise(res=>{
    const tx = idb.transaction('notes','readwrite');
    tx.objectStore('notes').put(n).onsuccess = ()=>res();
  });
}
async function localDelete(id){
  return new Promise(res=>{
    const tx = idb.transaction('notes','readwrite');
    tx.objectStore('notes').delete(id).onsuccess = ()=>res();
  });
}

// ---------- Supabase (облако) ----------
async function cloudList(){
  const { data, error } = await supabase.from('notes')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}
async function cloudUpsert(n){
  const { error } = await supabase.from('notes').upsert(n);
  if (error) throw error;
}
async function cloudDelete(id){
  const { error } = await supabase.from('notes').delete().eq('id', id).eq('user_id', userId);
  if (error) throw error;
}

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const listEl = $('#list');
const tagsEl = $('#tags');
const titleEl = $('#title');
const editorEl = $('#editor');
const searchEl = $('#search');
const metaEl = $('#meta');
const backlinksEl = $('#backlinks');

function uid(){ return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }
function now(){ return new Date().toISOString(); }
function strip(html){ const d=document.createElement('div'); d.innerHTML=html; return d.textContent || ''; }
function extractTags(text){
  const set = new Set();
  const re = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  let m; while((m=re.exec(text))) set.add(m[2].toLowerCase());
  return Array.from(set);
}
function highlight(text, q){
  if (!q) return text;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp('('+esc+')','gi'), '<mark>$1</mark>');
}

let state = { notes: [], activeId: null, tagFilter: null, query: '' };

async function loadNotes(){
  const data = useCloud ? await cloudList() : await localList();
  state.notes = data;
  if (!state.activeId && state.notes[0]) state.activeId = state.notes[0].id;
  renderList(); renderActive();
}

async function saveNotePartial(p){
  const n = state.notes.find(x=>x.id === state.activeId);
  if (!n) return;
  const updated = { ...n, ...p, updated_at: now() };
  const text = (updated.title || '') + ' ' + strip(updated.content || '');
  updated.tags = extractTags(text);
  if (useCloud) await cloudUpsert(updated); else await localPut(updated);
  await loadNotes();
}

async function createNote(){
  const n = { id: uid(), user_id: userId, title: 'Новая заметка', content: '', tags: [], created_at: now(), updated_at: now() };
  if (useCloud) await cloudUpsert(n); else await localPut(n);
  state.activeId = n.id;
  await loadNotes();
}

async function deleteNote(){
  const id = state.activeId;
  if (!id) return;
  if (!confirm('Удалить заметку?')) return;
  if (useCloud) await cloudDelete(id); else await localDelete(id);
  state.activeId = state.notes[0]?.id || null;
  await loadNotes();
}

// UI
$('#newNote').addEventListener('click', createNote);
$('#del').addEventListener('click', deleteNote);
document.querySelectorAll('[data-cmd]').forEach(btn=>{
  btn.addEventListener('click', ()=>document.execCommand(btn.dataset.cmd, false, null));
});
titleEl.addEventListener('input', ()=> saveNotePartial({ title: titleEl.value }));
editorEl.addEventListener('input', ()=> saveNotePartial({ content: editorEl.innerHTML }));
searchEl.addEventListener('input', ()=>{ state.query = searchEl.value.trim().toLowerCase(); renderList(); });

function openNote(id){ state.activeId = id; renderActive(); renderList(); editorEl.focus(); }
function listFiltered(){
  const q = state.query, tag = state.tagFilter;
  return state.notes.filter(n=>{
    const text = (n.title + ' ' + strip(n.content)).toLowerCase();
    const okQ = !q || text.includes(q) || (n.tags||[]).some(t=>t.includes(q));
    const okT = !tag || (n.tags||[]).includes(tag);
    return okQ && okT;
  });
}
function renderList(){
  const arr = listFiltered();
  listEl.innerHTML = '';
  arr.forEach(n=>{
    const div = document.createElement('div');
    div.className = 'item' + (n.id === state.activeId ? ' active' : '');
    const snippet = strip(n.content).slice(0, 140);
    const q = state.query;
    div.innerHTML = `
      <div class="title">${highlight(n.title || 'Без названия', q)}</div>
      <div class="snippet">${highlight(snippet, q)}</div>
      <div class="tags">${(n.tags||[]).map(t=>`<span class="tag">#${t}</span>`).join(' ')}</div>
    `;
    div.addEventListener('click', ()=>openNote(n.id));
    listEl.appendChild(div);
  });
  // tags bar
  const all = new Set(); state.notes.forEach(n => (n.tags||[]).forEach(t => all.add(t)));
  tagsEl.innerHTML = Array.from(all).sort().map(t => `<span class="tag" data-tag="${t}">#${t}</span>`).join(' ');
  tagsEl.querySelectorAll('.tag').forEach(el=>{
    el.addEventListener('click', ()=>{ state.tagFilter = el.dataset.tag; renderList(); });
  });
}
function renderActive(){
  const n = state.notes.find(x=>x.id === state.activeId);
  if (!n){ titleEl.value=''; editorEl.innerHTML=''; metaEl.textContent=''; backlinksEl.innerHTML=''; return; }
  titleEl.value = n.title || '';
  editorEl.innerHTML = n.content || '';
  metaEl.textContent = `Создано: ${new Date(n.created_at).toLocaleString()} · Обновлено: ${new Date(n.updated_at).toLocaleString()} · Теги: ${(n.tags||[]).map(x=>'#'+x).join(' ') || '—'}`;
  const linksTo = state.notes.filter(x => x.id !== n.id && (x.content||'').includes('[[' + (n.title || '') + ']]'));
  backlinksEl.innerHTML = !linksTo.length ? '<div class="meta">Пока нет</div>' :
    linksTo.map(b => `<div class="item"><div class="title">${b.title||'Без названия'}</div><div class="snippet">${strip(b.content).slice(0,120)}</div></div>`).join('');
}

// старт
await loadNotes();
