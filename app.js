// Apple-Notes style: заголовок = 1-я строка, LTR фикс, папки/подпапки, близкий визуал.
// Supabase (если есть config.json), иначе IndexedDB. Папки хранятся локально; если есть таблица folders в облаке — тоже используем.
//
// Таблицы в Supabase (опционально):
// notes:   id uuid pk, user_id text/uuid, title text, content text, tags text[], folder_id text, created_at ts, updated_at ts
// folders: id text pk, user_id text/uuid, name text, parent_id text null
//
// Примечание: title вычисляется из первой строки редактора на каждом вводе.

let supabase=null, useCloud=false;
let userId='public-user';

async function loadConfig(){
  try{
    const cfg=await fetch('./config.json').then(r=>r.json());
    const { SUPABASE_URL, SUPABASE_ANON_KEY }=cfg||{};
    if(SUPABASE_URL && SUPABASE_ANON_KEY){
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      useCloud = true;
    }
  }catch{ useCloud=false; }
}
await loadConfig();

/* ---------- IndexedDB ---------- */
let idb;
function idbInit(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open('notes-lite', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains('notes')) db.createObjectStore('notes',{keyPath:'id'});
      if(!db.objectStoreNames.contains('folders')) db.createObjectStore('folders',{keyPath:'id'});
    };
    req.onsuccess = ()=>{ idb=req.result; resolve(); };
    req.onerror = ()=>reject(req.error);
  });
}
await idbInit();

const idbGetAll = (store)=>new Promise(res=>{
  const tx=idb.transaction(store,'readonly'); const st=tx.objectStore(store);
  const req=st.getAll(); req.onsuccess=()=>res(req.result);
});
const idbPut = (store,obj)=>new Promise(res=>{
  const tx=idb.transaction(store,'readwrite'); tx.objectStore(store).put(obj).onsuccess=()=>res();
});
const idbDelete = (store,id)=>new Promise(res=>{
  const tx=idb.transaction(store,'readwrite'); tx.objectStore(store).delete(id).onsuccess=()=>res();
});

/* ---------- Cloud helpers ---------- */
async function cloudListNotes(){
  const { data, error } = await supabase.from('notes').select('*').eq('user_id',userId).order('updated_at',{ascending:false});
  if(error) throw error; return data;
}
async function cloudUpsertNote(n){
  const { error } = await supabase.from('notes').upsert(n);
  if(error) throw error;
}
async function cloudDeleteNote(id){
  const { error } = await supabase.from('notes').delete().eq('id',id).eq('user_id',userId);
  if(error) throw error;
}

async function cloudListFolders(){
  const { data, error } = await supabase.from('folders').select('*').eq('user_id',userId);
  if(error) throw error; return data;
}
async function cloudUpsertFolder(f){
  const { error } = await supabase.from('folders').upsert(f);
  if(error) throw error;
}

/* ---------- DOM ---------- */
const $ = s=>document.querySelector(s);
const listEl = $('#list');
const foldersTreeEl = $('#foldersTree');
const moveFolderSel = $('#moveFolder');
const titleFrom = (html) => {
  const div=document.createElement('div'); div.innerHTML = html || '';
  const text = (div.textContent||'').replace(/\r/g,'').split('\n').map(s=>s.trim()).find(s=>s.length>0) || '';
  return text.slice(0,160);
};
const strip = (html)=>{ const d=document.createElement('div'); d.innerHTML=html||''; return d.textContent||''; };
const nowIso = ()=>new Date().toISOString();
const uid = ()=> (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
function extractTags(text){
  const set=new Set(); const re=/(^|\s)#([\p{L}\p{N}_-]+)/gu; let m;
  while((m=re.exec(text))) set.add(m[2].toLowerCase());
  return Array.from(set);
}
function highlight(text,q){
  if(!q) return text; const esc=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.replace(new RegExp('('+esc+')','gi'),'<mark>$1</mark>');
}

/* ---------- State ---------- */
let state = {
  folders: [],
  notes: [],
  activeId: null,
  activeFolderId: 'root',
  query: ''
};

/* ---------- Folders local defaults ---------- */
function ensureDefaultFolders(){
  if(!state.folders.length){
    state.folders = [
      { id:'root', user_id:userId, name:'Мои заметки', parent_id:null }
    ];
  }
}

/* ---------- Load / Save ---------- */
async function loadAll(){
  // folders
  let folders = useCloud ? await (async()=>{ try{ return await cloudListFolders(); }catch{ return await idbGetAll('folders'); } })()
                          : await idbGetAll('folders');
  state.folders = folders || [];
  ensureDefaultFolders();
  // notes
  state.notes = useCloud ? await cloudListNotes() : await idbGetAll('notes');
  state.notes.sort((a,b)=> new Date(b.updated_at) - new Date(a.updated_at));
  if(!state.activeFolderId) state.activeFolderId = 'root';
  if(!state.activeId && state.notes[0]) state.activeId = state.notes[0].id;
  renderFolders(); renderMoveSelect(); renderList(); renderActive();
}

async function saveNotePartial(p){
  const n = state.notes.find(x=>x.id===state.activeId);
  if(!n) return;
  // вычисляем заголовок из первой строки каждый раз
  const html = p.content!==undefined ? p.content : n.content;
  const computedTitle = titleFrom(html);
  const title = computedTitle || 'Новая заметка';

  const textForTags = (title + ' ' + strip(html||''));
  const updated = {
    ...n,
    ...p,
    title,
    tags: extractTags(textForTags),
    updated_at: nowIso()
  };
  if(useCloud) await cloudUpsertNote(updated); else await idbPut('notes', updated);
  await loadAll();
}

async function createNote(){
  const folderId = state.activeFolderId || 'root';
  const n = {
    id: uid(),
    user_id: userId,
    title: 'Новая заметка',
    content: '',
    tags: [],
    folder_id: folderId,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  if(useCloud) await cloudUpsertNote(n); else await idbPut('notes', n);
  state.activeId = n.id;
  await loadAll();
}

async function deleteNote(){
  const id = state.activeId; if(!id) return;
  if(!confirm('Удалить заметку?')) return;
  if(useCloud) await cloudDeleteNote(id); else await idbDelete('notes', id);
  state.activeId = state.notes[0]?.id || null;
  await loadAll();
}

async function createFolder(){
  const name = prompt('Название папки'); if(!name) return;
  const f = { id: uid(), user_id: userId, name: name.trim(), parent_id: state.activeFolderId==='root'? null : state.activeFolderId };
  if(useCloud){ try{ await cloudUpsertFolder(f); } catch{ await idbPut('folders', f); } }
  else { await idbPut('folders', f); }
  await loadAll();
}

async function moveActiveToFolder(folderId){
  const n = state.notes.find(x=>x.id===state.activeId); if(!n) return;
  if(n.folder_id === folderId) return;
  await saveNotePartial({ folder_id: folderId });
}

/* ---------- UI Bindings ---------- */
$('#newNote').addEventListener('click', createNote);
$('#del').addEventListener('click', deleteNote);
$('#newFolder').addEventListener('click', createFolder);
$('#search').addEventListener('input', e=>{ state.query = e.target.value.trim().toLowerCase(); renderList(); });

document.querySelectorAll('[data-cmd]').forEach(btn=>{
  btn.addEventListener('click', ()=> document.execCommand(btn.dataset.cmd, false, null));
});

const editorEl = $('#editor');
const metaEl = $('#meta');
const listPaneEl = $('#list');
const backlinksEl = $('#backlinks');
const moveFolderEl = $('#moveFolder');

// ввод в редактор: правим title из 1-й строки, чиним LTR
editorEl.addEventListener('input', ()=>{
  editorEl.setAttribute('dir','ltr');
  editorEl.style.direction='ltr';
  const content = editorEl.innerHTML;
  saveNotePartial({ content });
});

/* ---------- Render ---------- */
function renderFolders(){
  // строим дерево
  const byParent = new Map();
  state.folders.forEach(f=>{
    const key = f.parent_id || 'root';
    if(!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  });
  const makeNode = (parentId, level=0)=>{
    const arr = byParent.get(parentId) || [];
    arr.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    return arr.map(f=>{
      const count = state.notes.filter(n => (n.folder_id||'root') === f.id).length;
      return `
        <div class="folder ${state.activeFolderId===f.id?'active':''}" data-id="${f.id}" style="padding-left:${6+level*14}px">
          <span>📁</span>
          <span class="name">${f.name}</span>
          <span class="count">${count}</span>
        </div>
        ${makeNode(f.id, level+1)}
      `;
    }).join('');
  };
  foldersTreeEl.innerHTML = `
    <div class="folder ${state.activeFolderId==='root'?'active':''}" data-id="root" style="padding-left:6px">
      <span>📁</span><span class="name">Мои заметки</span>
      <span class="count">${state.notes.filter(n=>(n.folder_id||'root')==='root').length}</span>
    </div>
    ${makeNode('root', 0)}
  `;
  foldersTreeEl.querySelectorAll('.folder').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.activeFolderId = el.getAttribute('data-id');
      renderFolders(); renderList();
    });
  });
}

function renderMoveSelect(){
  moveFolderEl.innerHTML = '';
  // плоский список с отступом по уровню
  const levelOf = (id, lvl=0)=>{
    const folder = state.folders.find(f=>f.id===id);
    if(!folder || !folder.parent_id) return lvl;
    return 1 + levelOf(folder.parent_id, lvl);
  };
  // плюс корень
  const all = [{id:'root', name:'Мои заметки', parent_id:null}, ...state.folders];
  all.forEach(f=>{
    const opt = document.createElement('option');
    const level = f.id==='root'?0:levelOf(f.id);
    opt.value = f.id;
    opt.textContent = ' '.repeat(level*2) + (f.id==='root'?'Мои заметки':f.name);
    moveFolderEl.appendChild(opt);
  });
  moveFolderEl.value = state.activeFolderId || 'root';
  moveFolderEl.onchange = ()=> moveActiveToFolder(moveFolderEl.value);
}

function listFiltered(){
  const q = state.query, fid = state.activeFolderId || 'root';
  return state.notes.filter(n=>{
    const inFolder = (n.folder_id||'root') === fid;
    if(!inFolder) return false;
    if(!q) return true;
    const text = (n.title + ' ' + strip(n.content)).toLowerCase();
    return text.includes(q) || (n.tags||[]).some(t=>t.includes(q));
  });
}

function renderList(){
  const arr = listFiltered();
  listEl.innerHTML='';
  arr.forEach(n=>{
    const div=document.createElement('div');
    div.className='item' + (n.id===state.activeId?' active':'');
    const snippet = strip(n.content).slice(0,120);
    div.innerHTML = `
      <div class="title">${n.title || 'Новая заметка'}</div>
      <div class="snippet">${snippet}</div>
      <div class="meta-row"><span>${new Date(n.updated_at).toLocaleString()}</span></div>
    `;
    div.addEventListener('click', ()=>{ state.activeId=n.id; renderActive(); renderList(); editorEl.focus(); });
    listEl.appendChild(div);
  });
}

function renderActive(){
  const n = state.notes.find(x=>x.id===state.activeId);
  if(!n){ editorEl.innerHTML=''; metaEl.textContent=''; backlinksEl.innerHTML=''; return; }
  editorEl.setAttribute('dir','ltr'); editorEl.style.direction='ltr'; // ещё раз фикс для iOS
  editorEl.innerHTML = n.content || '';
  metaEl.textContent = `Создано: ${new Date(n.created_at).toLocaleString()} · Обновлено: ${new Date(n.updated_at).toLocaleString()}`;

  moveFolderEl.value = n.folder_id || 'root';

  // простые backlinks по [[title]]
  const linksTo = state.notes.filter(x => x.id!==n.id && (x.content||'').includes('[['+(n.title||'')+']]'));
  backlinksEl.innerHTML = linksTo.length? linksTo.map(b=>`
    <div class="item"><div class="title">${b.title||'Без названия'}</div>
    <div class="snippet">${strip(b.content).slice(0,120)}</div></div>
  `).join('') : '<div class="meta">Пока нет</div>';
}

/* ---------- Go ---------- */
await loadAll();
