// Apple Notes-style: модалка для имени папки, заголовок = 1-я строка,
// LTR фикс, папки/подпапки, перенос заметок между папками,
// сортировка + ручной порядок (вверх/вниз для папок и заметок).

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

/* ========== IndexedDB ========== */
let idb;
function idbInit(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('notes-lite',3);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('notes'))   db.createObjectStore('notes',{keyPath:'id'});
      if(!db.objectStoreNames.contains('folders')) db.createObjectStore('folders',{keyPath:'id'});
    };
    req.onsuccess=()=>{idb=req.result;resolve();};
    req.onerror =()=>reject(req.error);
  });
}
await idbInit();
const idbAll = store => new Promise(res=>{ const tx=idb.transaction(store,'readonly'); const st=tx.objectStore(store); const q=st.getAll(); q.onsuccess=()=>res(q.result); });
const idbPut = (store,obj)=> new Promise(res=>{ const tx=idb.transaction(store,'readwrite'); tx.objectStore(store).put(obj).onsuccess=()=>res(); });
const idbDel = (store,id)=> new Promise(res=>{ const tx=idb.transaction(store,'readwrite'); tx.objectStore(store).delete(id).onsuccess=()=>res(); });

/* ========== Supabase helpers (опционально) ========== */
async function cloudListNotes(){ const {data,error}=await supabase.from('notes').select('*').eq('user_id',userId); if(error) throw error; return data; }
async function cloudUpsertNote(n){ const {error}=await supabase.from('notes').upsert(n); if(error) throw error; }
async function cloudDeleteNote(id){ const {error}=await supabase.from('notes').delete().eq('id',id).eq('user_id',userId); if(error) throw error; }
async function cloudListFolders(){ const {data,error}=await supabase.from('folders').select('*').eq('user_id',userId); if(error) throw error; return data; }
async function cloudUpsertFolder(f){ const {error}=await supabase.from('folders').upsert(f); if(error) throw error; }

/* ========== DOM refs ========== */
const $=s=>document.querySelector(s);
const foldersTreeEl=$('#foldersTree');
const listEl=$('#list');
const editorEl=$('#editor');
const moveFolderEl=$('#moveFolder');
const metaEl=$('#meta');
const searchEl=$('#search');
const noteUpBtn=$('#noteUp');
const noteDownBtn=$('#noteDown');
const newNoteBtn=$('#newNote');
const newFolderBtn=$('#newFolder');

/* modal */
const modal=$('#modal'), modalInput=$('#modalInput'), modalOk=$('#modalOk'), modalCancel=$('#modalCancel');

/* ========== utils ========== */
const uid=()=> (crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2));
const nowIso=()=>new Date().toISOString();
const strip=html=>{const d=document.createElement('div'); d.innerHTML=html||''; return d.textContent||'';};
const titleFrom=html=>{
  const d=document.createElement('div'); d.innerHTML=html||'';
  const first=(d.textContent||'').replace(/\r/g,'').split('\n').map(s=>s.trim()).find(Boolean) || '';
  return first.slice(0,160);
};
function extractTags(text){ const s=new Set(); const re=/(^|\s)#([\p{L}\p{N}_-]+)/gu; let m; while((m=re.exec(text))) s.add(m[2].toLowerCase()); return Array.from(s); }
function highlight(text,q){ if(!q)return text; const esc=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); return text.replace(new RegExp('('+esc+')','gi'),'<mark>$1</mark>'); }

/* ========== state ========== */
let state={
  folders:[],   // {id,name,parent_id,order_index,user_id}
  notes:[],     // {id,folder_id,title,content,tags,order_index,created_at,updated_at,user_id}
  activeFolderId:'root',
  activeId:null,
  query:''
};

function ensureDefaultFolders(){
  if(!state.folders.find(f=>f.id==='root')){
    state.folders.push({ id:'root', name:'Мои заметки', parent_id:null, order_index:0, user_id });
  }
}

/* ========== load/save ========== */
async function loadAll(){
  state.folders = useCloud ? await (async()=>{ try{return await cloudListFolders();}catch{return await idbAll('folders');} })() : await idbAll('folders');
  ensureDefaultFolders();

  state.notes = useCloud ? await cloudListNotes() : await idbAll('notes');

  // проставим order_index, если нет (по дате)
  state.folders.forEach((f,i)=>{ if(typeof f.order_index!=='number') f.order_index=i; });
  state.notes.forEach((n,i)=>{ if(typeof n.order_index!=='number') n.order_index=-i; });

  sortFolders(); sortNotes();

  if(!state.activeId && state.notes.length) state.activeId = state.notes[0].id;

  renderFolders(); renderMoveSelect(); renderList(); renderActive();
}

function sortFolders(){
  state.folders.sort((a,b)=>{
    if((a.parent_id||'')!== (b.parent_id||'')) return (a.parent_id||'').localeCompare(b.parent_id||'');
    return (a.order_index||0) - (b.order_index||0) || a.name.localeCompare(b.name,'ru');
  });
}
function sortNotes(){
  // сортируем в пределах папки по order_index (меньше выше)
  state.notes.sort((a,b)=>{
    const fa=(a.folder_id||'root'), fb=(b.folder_id||'root');
    if(fa!==fb) return fa.localeCompare(fb);
    return (a.order_index||0)-(b.order_index||0) || new Date(b.updated_at)-new Date(a.updated_at);
  });
}

async function persistFolder(f){
  if(useCloud){ try{ await cloudUpsertFolder(f);}catch{ await idbPut('folders',f);} }
  else await idbPut('folders',f);
}
async function persistNote(n){
  if(useCloud) await cloudUpsertNote(n); else await idbPut('notes',n);
}

async function saveNotePartial(p){
  const n=state.notes.find(x=>x.id===state.activeId); if(!n) return;
  const content = p.content!==undefined ? p.content : n.content;
  const computedTitle = titleFrom(content) || 'Новая заметка';
  const updated = {
    ...n, ...p,
    title: computedTitle,
    tags: extractTags((computedTitle+' '+strip(content||''))),
    updated_at: nowIso()
  };
  await persistNote(updated);
  // обновим state без перезагрузки
  Object.assign(n, updated);
  sortNotes();
  renderList(); renderActive();
}

async function createNote(){
  const folderId = state.activeFolderId || 'root';
  // order_index: выше всех — возьмём минимальный в папке и -1
  const inFolder = state.notes.filter(n=>(n.folder_id||'root')===folderId);
  const minOrder = inFolder.length? Math.min(...inFolder.map(n=>n.order_index||0)) : 0;
  const n={
    id:uid(), user_id, folder_id:folderId,
    title:'Новая заметка', content:'', tags:[],
    order_index: minOrder-1,
    created_at: nowIso(), updated_at: nowIso()
  };
  await persistNote(n);
  state.notes.push(n);
  state.activeId = n.id;
  sortNotes();
  renderList(); renderActive();
  editorEl.focus();
}

async function deleteNote(){
  const id=state.activeId; if(!id) return;
  if(!confirm('Удалить заметку?')) return;
  if(useCloud) await cloudDeleteNote(id); else await idbDel('notes',id);
  state.notes = state.notes.filter(n=>n.id!==id);
  state.activeId = state.notes[0]?.id || null;
  renderList(); renderActive();
}

async function createFolderModal(){
  // красивое модальное вместо prompt
  openModal(async (name)=>{
    if(!name) return;
    const parent = state.activeFolderId==='root' ? null : state.activeFolderId;
    // order_index в пределах одного parent_id
    const siblings = state.folders.filter(f=>(f.parent_id||null)===parent);
    const maxOrder = siblings.length? Math.max(...siblings.map(f=>f.order_index||0)) : 0;
    const f={ id:uid(), user_id, name:name.trim(), parent_id:parent, order_index:maxOrder+1 };
    await persistFolder(f);
    state.folders.push(f);
    sortFolders(); renderFolders(); renderMoveSelect();
  });
}

/* перемещение заметок и папок вверх/вниз */
function bumpOrder(arr, idxA, idxB){
  if(idxA<0||idxB<0||idxA>=arr.length||idxB>=arr.length) return;
  const a=arr[idxA], b=arr[idxB];
  const tmp=a.order_index; a.order_index=b.order_index; b.order_index=tmp;
}
async function moveActiveNote(delta){
  const fid = state.activeFolderId || 'root';
  const list = state.notes.filter(n=>(n.folder_id||'root')===fid);
  const idx = list.findIndex(n=>n.id===state.activeId);
  if(idx<0) return;
  const other = idx+delta;
  if(other<0 || other>=list.length) return;
  bumpOrder(list, idx, other);
  await Promise.all(list.map(persistNote));
  sortNotes(); renderList();
}
async function moveFolderUpDown(folderId, delta){
  const folder = state.folders.find(f=>f.id===folderId); if(!folder) return;
  const parent = folder.parent_id||null;
  const group = state.folders.filter(f=>(f.parent_id||null)===parent);
  const idx = group.findIndex(f=>f.id===folderId);
  const other = idx+delta; if(other<0||other>=group.length) return;
  bumpOrder(group, idx, other);
  await Promise.all(group.map(persistFolder));
  sortFolders(); renderFolders(); renderMoveSelect();
}

/* перенос заметки между папками — через select */
async function moveActiveToFolder(folderId){
  const n=state.notes.find(x=>x.id===state.activeId); if(!n) return;
  if((n.folder_id||'root')===folderId) return;
  // поставить сверху новой папки
  const inFolder = state.notes.filter(x=>(x.folder_id||'root')===folderId);
  const minOrder = inFolder.length? Math.min(...inFolder.map(x=>x.order_index||0)) : 0;
  n.folder_id = folderId;
  n.order_index = minOrder-1;
  await persistNote(n);
  sortNotes();
  renderList(); renderActive();
}

/* ========== UI bindings ========== */
newNoteBtn.addEventListener('click', createNote);
newFolderBtn.addEventListener('click', createFolderModal);
noteUpBtn.addEventListener('click', ()=>moveActiveNote(-1));
noteDownBtn.addEventListener('click', ()=>moveActiveNote(1));
$('#del').addEventListener('click', deleteNote);
searchEl.addEventListener('input', e=>{ state.query=e.target.value.trim().toLowerCase(); renderList(); });

document.querySelectorAll('[data-cmd]').forEach(btn=>{
  btn.addEventListener('click', ()=> document.execCommand(btn.dataset.cmd,false,null));
});

/* редактор: LTR фикс и мгновенное обновление списка */
editorEl.addEventListener('input', ()=>{
  editorEl.setAttribute('dir','ltr'); editorEl.style.direction='ltr';
  const content=editorEl.innerHTML;
  saveNotePartial({ content });
});

/* селектор переноса заметки между папками */
moveFolderEl.addEventListener('change', ()=> moveActiveToFolder(moveFolderEl.value));

/* ========== render ========== */
function renderFolders(){
  const byParent = new Map();
  state.folders.forEach(f=>{
    const k=f.parent_id||'root';
    if(!byParent.has(k)) byParent.set(k,[]);
    byParent.get(k).push(f);
  });
  const make = (parentId, level=0)=>{
    const arr=(byParent.get(parentId)||[]).sort((a,b)=> (a.order_index||0)-(b.order_index||0) || a.name.localeCompare(b.name,'ru'));
    return arr.map(f=>{
      const count = state.notes.filter(n=>(n.folder_id||'root')===f.id).length;
      return `
        <div class="folder ${state.activeFolderId===f.id?'active':''}" data-id="${f.id}" style="padding-left:${6+level*14}px">
          <span>📁</span>
          <span class="name">${f.id==='root'?'Мои заметки':f.name}</span>
          <span class="count">${count}</span>
          <span style="margin-left:auto;display:flex;gap:6px">
            ${f.id!=='root'? `<button class="btn-ghost fup" title="Вверх">▲</button>
                               <button class="btn-ghost fdown" title="Вниз">▼</button>`:''}
          </span>
        </div>
        ${make(f.id, level+1)}
      `;
    }).join('');
  };
  foldersTreeEl.innerHTML = make('root', 0);

  foldersTreeEl.querySelectorAll('.folder').forEach(el=>{
    const id=el.getAttribute('data-id');
    // click — выбрать папку
    el.addEventListener('click', (ev)=>{
      // не переключать при клике по кнопкам стрелок
      if(ev.target.closest('.fup,.fdown')) return;
      state.activeFolderId=id; renderFolders(); renderList();
    });
    // стрелки
    const up=el.querySelector('.fup'), down=el.querySelector('.fdown');
    if(up) up.addEventListener('click',(e)=>{ e.stopPropagation(); moveFolderUpDown(id,-1); });
    if(down) down.addEventListener('click',(e)=>{ e.stopPropagation(); moveFolderUpDown(id,1); });
  });
}

function renderMoveSelect(){
  moveFolderEl.innerHTML='';
  const all=[{id:'root',name:'Мои заметки',parent_id:null}, ...state.folders.filter(f=>f.id!=='root')];
  const levelOf=(id,l=0)=>{ const f=state.folders.find(x=>x.id===id); if(!f||!f.parent_id) return l; return levelOf(f.parent_id,l+1); };
  all.forEach(f=>{
    const opt=document.createElement('option');
    const lvl = f.id==='root'?0:levelOf(f.id);
    opt.value=f.id; opt.textContent = ' '.repeat(lvl*2) + (f.id==='root'?'Мои заметки':f.name);
    moveFolderEl.appendChild(opt);
  });
}

function listFiltered(){
  const q=state.query, fid=state.activeFolderId||'root';
  return state.notes.filter(n=>{
    const okFolder=(n.folder_id||'root')===fid;
    if(!okFolder) return false;
    if(!q) return true;
    const text=(n.title+' '+strip(n.content)).toLowerCase();
    return text.includes(q) || (n.tags||[]).some(t=>t.includes(q));
  });
}

function renderList(){
  const arr=listFiltered();
  listEl.innerHTML='';
  arr.forEach(n=>{
    const div=document.createElement('div');
    div.className='item' + (n.id===state.activeId?' active':'');
    const snippet=strip(n.content).slice(0,120);
    const q=state.query;
    div.innerHTML=`
      <div class="title">${highlight(n.title||'Новая заметка', q)}</div>
      <div class="snippet">${highlight(snippet, q)}</div>
      <div class="meta-row">
        <span>${new Date(n.updated_at).toLocaleString()}</span>
      </div>
    `;
    div.addEventListener('click',()=>{ state.activeId=n.id; renderActive(); renderList(); editorEl.focus(); });
    listEl.appendChild(div);
  });
}

function renderActive(){
  const n=state.notes.find(x=>x.id===state.activeId);
  if(!n){ editorEl.innerHTML=''; metaEl.textContent=''; return; }
  editorEl.setAttribute('dir','ltr'); editorEl.style.direction='ltr';
  editorEl.innerHTML = n.content || '';
  metaEl.textContent = `Создано: ${new Date(n.created_at).toLocaleString()} · Обновлено: ${new Date(n.updated_at).toLocaleString()}`;
  moveFolderEl.value = n.folder_id || 'root';
}

/* ======= modal helpers ======= */
function openModal(onOk){
  modal.classList.remove('hidden');
  modalInput.value=''; modalInput.focus();
  const ok=async ()=>{
    const v=modalInput.value.trim();
    closeModal();
    await onOk(v);
  };
  const cancel=()=> closeModal();
  modalOk.onclick=ok; modalCancel.onclick=cancel;
  modal.addEventListener('click', e=>{ if(e.target===modal) closeModal(); }, {once:true});
  modalInput.onkeydown=(e)=>{ if(e.key==='Enter') ok(); if(e.key==='Escape') cancel(); };
}
function closeModal(){ modal.classList.add('hidden'); modalOk.onclick=null; modalCancel.onclick=null; modalInput.onkeydown=null; }

/* ========== go ========== */
await loadAll();
