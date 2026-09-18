(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const clean = (s,n=240) => String(s||'').replace(/\s+/g,' ').trim().slice(0,n);
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e) || e.matches('script,style,noscript,template,svg')) return '';
    seen.add(e);
    const root=e.getRootNode(), doc=e.ownerDocument;
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(root.getElementById?.(id)||doc.getElementById(id),seen)).filter(Boolean).join(' ');
    return clean(referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && visible(n) ? name(n,seen) : '').join(' ')) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('name') || '');
  };
  const roots=[document], frames=[], missing=[];
  // Open shadow roots and same-origin frames are observed directly, never guessed selectors.
  for (let i=0;i<roots.length && roots.length<64;i++) {
    for (const e of roots[i].querySelectorAll('*')) {
      if (e.shadowRoot) roots.push(e.shadowRoot);
      if (e.tagName==='IFRAME' && visible(e)) {
        frames.push(e);
        try { if (e.contentDocument?.body) roots.push(e.contentDocument); else missing.push(name(e)||e.src); }
        catch { missing.push(name(e)||e.src); }
      }
    }
  }
  const all = selector => roots.flatMap(root=>[...root.querySelectorAll(selector)]);
  // Hidden native controls can have an explicit visible label that is their interaction surface.
  cache.surface=e=>{
    if (visible(e) && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0) return e;
    if (!['file','radio','checkbox'].includes(e.type)) return null;
    const label=[...(e.labels||[])].find(l=>visible(l) && l.getBoundingClientRect().width>0);
    if (label) return label;
    // Custom upload/radio widgets often put an opacity-zero native input over a visible surface.
    // It must retain real geometry and pointer input; geometry() still checks the exact hit target.
    const r=e.getBoundingClientRect();
    if (r.width>0 && r.height>0 && visible(e.parentElement) &&
        e.checkVisibility({checkOpacity:false,checkVisibilityCSS:true}) &&
        getComputedStyle(e).pointerEvents!=='none') return e;
    return null;
  };
  cache.geometry=e=>{
    if (!e?.isConnected) return null;
    e=cache.surface(e); if (!e) return null;
    const r=e.getBoundingClientRect(); let x=r.x+r.width/2,y=r.y+r.height/2;
    let doc=e.ownerDocument, target=e, within=true, offscreen=false;
    const hit = (root,px,py,t) => {
      let found=root.elementFromPoint(px,py);
      while (found?.shadowRoot) {
        const inner=found.shadowRoot.elementFromPoint(px,py);
        if (!inner || inner===found) break;
        found=inner;
      }
      return !!found && (t===found || t.contains(found));
    };
    while (doc) {
      const win=doc.defaultView;
      offscreen=offscreen || x<0 || y<0 || x>=win.innerWidth || y>=win.innerHeight;
      within=within && !offscreen && hit(doc,x,y,target);
      if (doc===document) break;
      const frame=win.frameElement;
      if (!frame?.isConnected || !visible(frame)) return null;
      const fr=frame.getBoundingClientRect();
      // Transformed frames require a different coordinate mapping and are explicitly unsupported.
      if (Math.abs(fr.width-frame.offsetWidth)>1 || Math.abs(fr.height-frame.offsetHeight)>1) return null;
      x+=fr.x+frame.clientLeft; y+=fr.y+frame.clientTop; target=frame; doc=frame.ownerDocument;
    }
    return {x,y,w:r.width,h:r.height,within:within && r.width>0 && r.height>0,offscreen};
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton','slider'];
  const selector='a,button,input,textarea,select,summary,[onclick],[tabindex],[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio','range','file'].includes(e.type)) return e.type==='range'?'slider':e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel','date','datetime-local','time','month','week'].includes(e.type)) return 'textbox';
    }
    if (e.hasAttribute('onclick') || e.tabIndex>=0) return 'button';
    return null;
  };
  const context=e=>{
    const scope=e.closest('label,fieldset,tr,[role="group"],li')||e.parentElement;
    return scope && !['BODY','HTML'].includes(scope.tagName) ? clean(scope.innerText,360) : '';
  };
  const fieldLabel=e=>{
    if (!e.isContentEditable && !e.matches('input,textarea,select')) return name(e);
    if (e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') || e.labels?.length) return name(e);
    for (let scope=e.parentElement,depth=0;scope && depth<3;scope=scope.parentElement,depth++) {
      if (['BODY','HTML','FORM'].includes(scope.tagName)) break;
      const label=[...scope.children].find(n=>n.tagName==='LABEL' && !n.contains(e));
      if (label) return name(label);
    }
    return e.isContentEditable ? e.getAttribute('data-placeholder') || e.getAttribute('aria-placeholder') || 'Rich text editor' : name(e);
  };
  cache.documentKey=()=>[performance.timeOrigin,location.href];
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    all('input,textarea,select').filter(safe).map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!cache.geometry(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),fieldLabel(e),e.isContentEditable?e.innerText:e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[], offscreen=[], fields=[];
  for (const e of all(selector)) {
    if (!safe(e) || !cache.surface(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) continue;
    const g=cache.geometry(e), rname=role(e);
    if (!rname || !g || g.w<=0 || g.h<=0) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:fieldLabel(e)||rname,context:context(e),
      rect:{x:g.x-g.w/2,y:g.y-g.h/2,w:g.w,h:g.h},
      input_type:e.type||null,required:!!e.required,placeholder:e.getAttribute('placeholder')||'',
      value:e.type==='file' ? [...e.files].map(f=>f.name).join(', ') :
        'value' in e ? String(e.value) : e.isContentEditable ? e.innerText : ''};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key); if (value!==null) base[key]=value;
    }
    if (e.tagName==='A') base.href=e.href;
    if (e.validity && !e.validity.valid) base.validation=e.validationMessage;
    for (const k of ['min','max','step','pattern','accept']) if (e.getAttribute(k)) base[k]=e.getAttribute(k);
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.matches('input,textarea,select') || e.isContentEditable) {
      fields.push({...base,value:e.tagName==='SELECT'?[...e.selectedOptions].map(o=>o.label).join(', '):base.value,
        valid:e.validity ? e.validity.valid : null,offscreen:g.offscreen});
    }
    if (!g.within) {
      // Offscreen is different from covered: scrolling cannot dismiss a modal.
      if (g.offscreen)
        offscreen.push({...base,kind:'scroll_to',label:'Scroll to '+base.label});
      continue;
    }
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else if (e.type==='file') {
      actions.push({...base,kind:'upload'});
    } else if (['date','datetime-local','time','month','week','range'].includes(e.type) && !e.readOnly) {
      actions.push({...base,kind:'set_value'});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      actions.push({...base,kind:editable?'fill':e.tagName==='A' && e.target==='_blank' && /^https?:/.test(e.href)?'open_link':'click'});
      if (editable && rname==='combobox') actions.push({...base,kind:'click',label:'Open '+base.label});
    }
  }
  const fragments=[]; let focus=document.activeElement, visited=0;
  if (!focus || ['BODY','HTML'].includes(focus.tagName)) focus=null;
  while (focus?.shadowRoot?.activeElement) focus=focus.shadowRoot.activeElement;
  for (const root of roots) {
    const doc=root.ownerDocument||root, walker=doc.createTreeWalker(root.body||root,NodeFilter.SHOW_TEXT);
    const range=doc.createRange(); let node;
    while (visited<12000 && (node=walker.nextNode())) {
      visited++;
      const value=node.textContent.trim(), parent=node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node); const r=range.getBoundingClientRect();
      if (r.width<=0 || r.height<=0) continue;
      let x=r.x,y=r.y,owner=doc;
      while (owner!==document && owner.defaultView?.frameElement) {
        const frame=owner.defaultView.frameElement, fr=frame.getBoundingClientRect();
        x+=fr.x+frame.clientLeft; y+=fr.y+frame.clientTop; owner=frame.ownerDocument;
      }
      fragments.push({text:value,x,y,inView:y+r.height>0 && y<innerHeight});
    }
  }
  // CSS ordering can differ from DOM order. Sort rendered text before applying context limits.
  fragments.sort((a,b)=>Math.round(a.y/3)-Math.round(b.y/3) || a.x-b.x);
  const full=fragments.map(f=>f.text), words=fragments.filter(f=>f.inView).map(f=>f.text);
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  const omitted_actions=Math.max(0,actions.length+offscreen.length-240);
  actions.push(...offscreen.slice(0,Math.max(0,240-actions.length)));actions.splice(240);
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,full.join('\n').slice(0,16000),semantics,page_key[6],focus?identity(focus):null,history.length];
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down to read more',delta:innerHeight*.8});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-innerHeight*.8});
  if (focus && focus!==document.body) {
    actions.push({id:'enter',kind:'key',key:'Enter',label:'Press Enter in focused '+name(focus)});
    actions.push({id:'escape',kind:'key',key:'Escape',label:'Press Escape to dismiss an open popup/menu'});
  }
  if (history.length>1) actions.push({id:'back',kind:'back',label:'Go back to the previous page'});
  actions.push({id:'reload',kind:'reload',label:'Reload a blank or failed page'});
  actions.push({id:'search_web',kind:'search',label:'Search the web using Bing; a text helper writes the query'});
  actions.push({id:'wait',kind:'wait',label:'Wait briefly for loading or new controls'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    document_text:full.join('\n').slice(0,16000),ready_state:document.readyState,fields,
    unsupported_frames:missing,frame_count:frames.length,focus:focus ? {node:identity(focus),role:role(focus),label:name(focus)} : null,
    scroll:{y:scrollY,height},actions,marker,page_key,document_key:cache.documentKey(),guards,omitted_actions};
})()
