'use strict';
// ARU Visit CRM — Node.js standard library only (Node >= 18).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const FILE = process.env.CRM_DATA_FILE || path.join(ROOT, 'data.json');
const INDEX = path.join(ROOT, 'index.html');
const PORT = Number(process.env.PORT || 3215);
const HOST = process.env.HOST || '127.0.0.1';
const sessions = new Map();
const rate = new Map();
const MAX_BODY = 5_000_000; // Keep under Hestia's existing 8 MB reverse-proxy limit
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const txt = (value, max = 150) => String(value ?? '').trim().slice(0, max);
const safeUsername = s => /^[a-z0-9._-]{3,30}$/.test(s);
const hashPassword = pwd => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pwd, salt, 64).toString('hex')}`;
};
const verifyPassword = (pwd, stored) => {
  try {
    const [algo, salt, hex] = stored.split('$');
    if (algo !== 'scrypt' || !salt || hex.length !== 128) return false;
    const candidate = crypto.scryptSync(pwd, salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), candidate);
  } catch { return false; }
};
const fresh = () => ({
  app: { name: 'ARU Visit CRM', organization: 'PT ARU Raharja', version: '4.4.0', storage: 'json-server' },
  settings: { gpsRequired: true, maxPhotos: 4, maxPhotoWidth: 1200, maxImageBytes: 700000 },
  departments: ['Operasional', 'Keuangan', 'SDM & Umum', 'IT', 'Manajemen', 'Sekretariat', 'Pemasaran', 'Lainnya'],
  visitTypes: ['Kunjungan Vendor','Kunjungan Klien','Pertemuan Mitra','Koordinasi WhatsApp','Rapat / Diskusi','Monitoring Pekerjaan','Tindak Lanjut','Laporan Lainnya'],
  users: [], visits: [], audit: []
});
function initialAdminPassword() {
  const value=process.env.CRM_INITIAL_ADMIN_PASSWORD;
  if (!value || value.length<12) throw new Error('CRM_INITIAL_ADMIN_PASSWORD minimal 12 karakter wajib disediakan saat membuat admin baru.');
  return value;
}
function load() {
  const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : fresh();
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.visits)) db.visits = [];
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!Array.isArray(db.departments)) db.departments = fresh().departments;
  if (!Array.isArray(db.visitTypes)) db.visitTypes = fresh().visitTypes;
  // Default admin generated only for brand-new installations. No plaintext password is stored.
  if (!db.users.some(u => u.role === 'admin')) {
    db.users.unshift({ id: uid(), username: 'admin', name: 'Administrator ARU', department: 'Manajemen',
      position: 'Administrator Sistem', email: '', phone: '', profilePhoto: '', role: 'admin', status: 'active',
      passwordHash: hashPassword(initialAdminPassword()), mustChangePassword: true, createdAt: now(), approvedAt: now() });
    persist(db);
    process.stdout.write('[SETUP] Akun admin awal dibuat menggunakan kredensial privat server; ganti kata sandi setelah login.\n');
  }
  return db;
}
function persist(db) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
const db = load();
function record(actor, action, target) {
  db.audit.push({ at: now(), actorId: actor, action, targetId: target });
  if (db.audit.length > 1000) db.audit = db.audit.slice(-1000);
  persist(db);
}
const exposed = u => ({ id:u.id, username:u.username, name:u.name, department:u.department, position:u.position,
  email:u.email || '', phone:u.phone || '', profilePhoto:u.profilePhoto || '', role:u.role, status:u.status,
  mustChangePassword:!!u.mustChangePassword, createdAt:u.createdAt, approvedAt:u.approvedAt || null });
const userList = u => ({ ...exposed(u), profilePhoto: u.profilePhoto || '' });
function reply(res, code, data, headers={}) {
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY', ...headers
  });
  res.end(JSON.stringify(data));
}
const fail = (res, code, message) => reply(res, code, { error: message });
function cookies(req) {
  const out = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const i = item.indexOf('=');
    if (i !== -1) out[item.slice(0,i).trim()] = item.slice(i+1).trim();
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).arucrm_session;
  if (!token) return null;
  const sess = sessions.get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!sess || sess.expiresAt < Date.now()) return null;
  sess.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const u = db.users.find(x => x.id === sess.userId && x.status === 'active');
  return u || null;
}
const sessionKey = token => crypto.createHash('sha256').update(token).digest('hex');
function setSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionKey(token), { userId:user.id, expiresAt:Date.now()+12*60*60*1000 });
  const host = (req.headers.host || '').split(':')[0];
  const secure = !['localhost','127.0.0.1','::1','[::1]'].includes(host);
  return `arucrm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure?'; Secure':''}`;
}
function limited(key, limit=12, duration=15*60*1000) {
  const t = Date.now();
  const prev = rate.get(key) || [];
  const next = prev.filter(x => t - x < duration);
  next.push(t); rate.set(key, next);
  return next.length > limit;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject({ status:413, message:'Data terlalu besar (maksimal 5 MB).' }); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject({ status:400, message:'JSON tidak valid.' }); } });
    req.on('error', reject);
  });
}
function imageValid(s, max=700000) {
  return !s || (typeof s === 'string' && s.length <= max && /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(s));
}
// Every attachment is stored in the same private JSON file, not under public_html.
// Only image, PDF, and text/plain are accepted; no HTML/SVG or executable files.
const MAX_ATTACHMENT = 650000; // base64 characters, ~487 KB each
const validReportTypes = ['Kunjungan Vendor','Kunjungan Klien','Pertemuan Mitra','Koordinasi WhatsApp','Rapat / Diskusi','Monitoring Pekerjaan','Tindak Lanjut','Laporan Lainnya','Survei Lapangan','Lainnya'];
const validPartyTypes = ['vendor','klien','mitra','internal','lainnya'];
const validModes = ['onsite','remote','hybrid'];
const validProgress = ['baru','proses','menunggu','selesai'];
const validChannels = ['WhatsApp','Telepon','Email','Tatap Muka','Rapat Online','Lainnya'];
const isDay = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value+'T00:00:00Z')));
function parseEvidence(raw, max=6) {
  if (!Array.isArray(raw) || raw.length>max) throw {status:400,message:`Maksimal ${max} lampiran per pengiriman.`};
  return raw.map(x => {
    const name=txt(x?.name,120);
    const data=x?.data;
    if (!name || !data || typeof data!=='string' || data.length>MAX_ATTACHMENT) throw {status:400,message:'Nama atau ukuran lampiran tidak valid (maksimal sekitar 480 KB per file).'};
    const match=/^data:(image\/(?:jpeg|png|webp)|application\/pdf|text\/plain);base64,([a-zA-Z0-9+/=]+)$/.exec(data);
    if (!match) throw {status:400,message:'Lampiran hanya mendukung JPG, PNG, WebP, PDF, atau TXT.'};
    const mime=match[1],bytes=Buffer.from(match[2],'base64');
    if (!bytes.length || bytes.length>490000 || bytes.toString('base64').replace(/=+$/,'')!==match[2].replace(/=+$/,''))
      throw {status:400,message:'Format lampiran rusak atau melebihi ukuran.'};
    const good = mime==='application/pdf' ? bytes.subarray(0,5).toString()==='%PDF-' :
      mime==='image/png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
      mime==='image/jpeg' ? bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff :
      mime==='image/webp' ? bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP' :
      !bytes.includes(0);
    if (!good) throw {status:400,message:'Isi file lampiran tidak cocok dengan jenis file.'};
    return {id:uid(),name,mime,data,addedAt:now()};
  });
}
function validateGps(gps, required, prev) {
  if (!required) return null; // Never claim the current phone coordinates are a remote meeting location.
  if (!gps || !Number.isFinite(Number(gps.latitude)) || !Number.isFinite(Number(gps.longitude)) ||
       Math.abs(Number(gps.latitude))>90 || Math.abs(Number(gps.longitude))>180 ||
       !Number.isFinite(Number(gps.accuracyMeters)) || Number(gps.accuracyMeters)<0 || Number(gps.accuracyMeters)>100000)
    throw {status:400,message:'GPS valid wajib untuk kegiatan lapangan.'};
  if (!Number.isFinite(Date.parse(gps.capturedAt)) || Math.abs(Date.now()-Date.parse(gps.capturedAt))>120000)
    throw {status:400,message:'Posisi GPS tidak terbaru. Perbarui GPS dan coba lagi.'};
  return {latitude:Number(gps.latitude), longitude:Number(gps.longitude),accuracyMeters:Number(gps.accuracyMeters),capturedAt:gps.capturedAt,checkedInAt:prev?.gps?.checkedInAt||now()};
}
function makeVisit(input, user, prev=null) {
  const v = prev ? {...prev} : {id:uid(),userId:user.id,createdAt:now(),updates:[]};
  const reportType=txt(input.reportType||input.visitType,80)||'Laporan Lainnya';
  if (!validReportTypes.includes(reportType)) throw {status:400,message:'Jenis laporan tidak valid.'};
  const partyType=txt(input.partyType||'lainnya',30).toLowerCase();
  const activityMode=txt(input.activityMode||'onsite',30).toLowerCase();
  const progressStatus=txt(input.progressStatus||'baru',30).toLowerCase();
  if (!validPartyTypes.includes(partyType) || !validModes.includes(activityMode) || !validProgress.includes(progressStatus))
    throw {status:400,message:'Jenis pihak, mode kegiatan, atau status progres tidak valid.'};
  v.reportType=reportType;v.visitType=reportType;v.partyType=partyType;v.activityMode=activityMode;v.progressStatus=progressStatus;
  v.reportDate=txt(input.reportDate,10)||now().slice(0,10);
  v.followUpDate=txt(input.followUpDate,10);
  if (!isDay(v.reportDate)||!isDay(v.followUpDate)) throw {status:400,message:'Format tanggal kegiatan/tindak lanjut tidak valid.'};
  for (const [field,max] of Object.entries({reportTitle:180,organizationName:180,contactName:180,contactPosition:100,
      purpose:2500,outcome:4500,nextStep:2500,discussionPoints:4500,signerName:180,signerRole:100}))
    v[field]=txt(input[field],max);
  v.status=input.status==='completed'?'completed':'draft';
  if (!v.organizationName || !v.purpose) throw {status:400,message:'Nama organisasi dan tujuan kegiatan wajib diisi.'};
  if (v.status==='completed'&&!v.outcome) throw {status:400,message:'Isi hasil/ringkasan kegiatan sebelum menyelesaikan laporan.'};
  v.gps=validateGps(input.gps, activityMode==='onsite'||activityMode==='hybrid',prev);
  if (!Array.isArray(input.photos)||input.photos.length>4||
      !input.photos.every(x=>typeof x==='string' && x.length>100 && imageValid(x,700000)))
    throw {status:400,message:'Maksimal 4 foto kegiatan dalam format JPG/PNG/WebP yang valid.'};
  v.photos=input.photos;
  if (!imageValid(input.signature,400000)) throw {status:400,message:'Tanda tangan tidak valid.'};
  v.signature=input.signature||'';
  if (v.signature&&!v.signerName) throw {status:400,message:'Isi nama penandatangan jika menggunakan tanda tangan.'};
  v.signedAt=v.signature ? (prev?.signature===v.signature ? (prev.signedAt||now()) : now()) : null;
  const rawFields=Array.isArray(input.customFields)?input.customFields:[];
  if(rawFields.length>12) throw {status:400,message:'Maksimal 12 kolom informasi tambahan.'};
  v.customFields=rawFields.map(f=>({label:txt(f?.label,80),value:txt(f?.value,1200)})).filter(f=>f.label&&f.value);
  v.evidence=parseEvidence(input.evidence||[],6);
  // Drafts may be incomplete, but a completed report must have evidence of the activity.
  if (v.status==='completed') {
    const fieldActivity=activityMode==='onsite'||activityMode==='hybrid';
    if (fieldActivity && !v.photos.length)
      throw {status:400,message:'Laporan tatap muka/lapangan wajib melampirkan minimal 1 foto kegiatan.'};
    if (!v.evidence.length)
      throw {status:400,message:fieldActivity
        ? 'Laporan tatap muka/lapangan wajib memiliki minimal 1 bukti pendukung operasional.'
        : 'Laporan jarak jauh/elektronik wajib memiliki minimal 1 bukti komunikasi atau dokumen pendukung.'};
  }
  if (!Array.isArray(v.updates)) v.updates=[];
  if (v.evidence.length+v.updates.reduce((n,x)=>n+(x.evidence?.length||0),0)>12)
    throw {status:400,message:'Batas total 12 lampiran per laporan sudah tercapai.'};
  v.updatedAt=now();
  if(v.status==='completed')v.completedAt=prev?.completedAt||now();
  return v;
}

function mutationAllowed(req) {
  if (req.headers['x-crm-request'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Node CLI or same-origin without Origin
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && parsed.protocol === (req.socket.encrypted ? 'https:' : (req.headers['x-forwarded-proto']==='https' ? 'https:' : 'http:'));
  } catch { return false; }
}
function handleGet(req, res, url, u) {
  if (url.pathname === '/api/auth/me') return reply(res, 200, { user:u ? exposed(u) : null, departments:db.departments, visitTypes:db.visitTypes });
  if (!u) return fail(res,401,'Silakan login terlebih dahulu.');
  if (url.pathname === '/api/visits') {
    const entries = db.visits.filter(v => !v.deletedAt && (u.role === 'admin' || v.userId === u.id));
    return reply(res,200,{ visits:entries.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(v => ({...v, reporter:db.users.find(x=>x.id===v.userId)?.name || 'Pengguna'})) });
  }
  if (url.pathname === '/api/visits/trash') {
    if (u.role !== 'admin') return fail(res,403,'Hanya admin yang dapat melihat laporan terhapus.');
    const entries=db.visits.filter(v=>v.deletedAt);
    return reply(res,200,{visits:entries.slice().sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt)).map(v=>({...v,reporter:db.users.find(x=>x.id===v.userId)?.name||'Pengguna'}))});
  }
  if (url.pathname === '/api/users') {
    if (u.role !== 'admin') return fail(res,403,'Hanya admin yang dapat melihat daftar pegawai.');
    return reply(res,200,{ users:db.users.map(userList) });
  }
  if (url.pathname === '/api/export') {
    const entries = db.visits.filter(v => !v.deletedAt && (u.role === 'admin' || v.userId === u.id));
    return reply(res,200,{ exportedAt:now(), visits:entries });
  }
  return fail(res,404,'Endpoint tidak ditemukan.');
}
async function handlePost(req,res,url,u) {
  if (!mutationAllowed(req)) return fail(res,403,'Permintaan tidak diperbolehkan.');
  const body = await readBody(req);
  const ip = req.socket.remoteAddress || 'unknown';
  if (url.pathname === '/api/auth/register') {
    if (limited(`register:${ip}`,8,60*60*1000)) return fail(res,429,'Terlalu banyak percobaan registrasi.');
    const username=txt(body.username,40).toLowerCase();
    const password=String(body.password || '');
    const name=txt(body.name,100);
    if (!safeUsername(username) || name.length<3 || password.length<8 || password.length>128)
      return fail(res,400,'Nama minimal 3 karakter, username 3–30 (huruf kecil/angka/._-), password minimal 8 karakter.');
    if (db.users.some(x => x.username===username)) return fail(res,409,'Username sudah dipakai.');
    const user={ id:uid(),username,name,department:txt(body.department,80)||'Lainnya',position:txt(body.position,100)||'Staf',
      email:txt(body.email,160), phone:txt(body.phone,40), profilePhoto:'', passwordHash:hashPassword(password),
      role:'staff',status:'pending',mustChangePassword:false,createdAt:now(),approvedAt:null };
    db.users.push(user);record(user.id,'REGISTER',user.id);
    return reply(res,201,{message:'Registrasi terkirim. Menunggu persetujuan admin.'});
  }
  if (url.pathname === '/api/auth/login') {
    const username=txt(body.username,40).toLowerCase();
    if (limited(`login:${ip}:${username}`,12)) return fail(res,429,'Terlalu banyak percobaan. Coba lagi beberapa saat.');
    const user=db.users.find(x=>x.username===username);
    if (!user || !verifyPassword(String(body.password || ''),user.passwordHash)) return fail(res,401,'Username atau password salah.');
    if (user.status !== 'active') return fail(res,403,user.status==='pending'?'Akun masih menunggu persetujuan admin.':'Akun tidak aktif. Hubungi admin.');
    return reply(res,200,{user:exposed(user)}, {'Set-Cookie':setSession(req,res,user)});
  }
  if (url.pathname === '/api/auth/logout') {
    const token=cookies(req).arucrm_session;
    if (token) sessions.delete(sessionKey(token));
    return reply(res,200,{ok:true},{'Set-Cookie':'arucrm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
  }
  if (!u) return fail(res,401,'Silakan login terlebih dahulu.');
  if (url.pathname === '/api/auth/password') {
    if (String(body.password || '').length < 8 || String(body.password || '').length > 128)
      return fail(res,400,'Password baru minimal 8 karakter dan maksimal 128.');
    if (!verifyPassword(String(body.currentPassword||''),u.passwordHash)) return fail(res,403,'Password lama salah.');
    if (String(body.password) === String(body.currentPassword)) return fail(res,400,'Password baru harus berbeda.');
    u.passwordHash=hashPassword(String(body.password));u.mustChangePassword=false;
    record(u.id,'CHANGE_PASSWORD',u.id);
    return reply(res,200,{user:exposed(u),message:'Password berhasil diperbarui.'});
  }
  if (u.mustChangePassword) return fail(res,403,'Ganti password awal terlebih dahulu.');
  if (url.pathname === '/api/profile') {
    const name=txt(body.name,100);
    if (name.length<3) return fail(res,400,'Nama minimal 3 karakter.');
    if (!imageValid(body.profilePhoto,500000)) return fail(res,400,'Foto profil tidak valid atau terlalu besar.');
    u.name=name;u.department=txt(body.department,80)||u.department;u.position=txt(body.position,100)||u.position;
    u.email=txt(body.email,160);u.phone=txt(body.phone,40);
    if (body.profilePhoto !== undefined) u.profilePhoto=body.profilePhoto;
    record(u.id,'UPDATE_PROFILE',u.id);
    return reply(res,200,{user:exposed(u),message:'Profil berhasil disimpan.'});
  }
  if (url.pathname === '/api/users') {
    if (u.role!=='admin') return fail(res,403,'Hanya admin yang dapat membuat akun.');
    const username=txt(body.username,40).toLowerCase();
    const password=String(body.password||'');
    const role=body.role === undefined ? 'staff' : txt(body.role,20);
    if (!['staff','admin'].includes(role)) return fail(res,400,'Peran akun tidak valid.');
    if (!safeUsername(username) || txt(body.name,100).length<3 || password.length<8 || password.length>128)
      return fail(res,400,'Lengkapi nama, username valid, dan password 8–128 karakter.');
    if (db.users.some(x=>x.username===username)) return fail(res,409,'Username sudah terdaftar.');
    const entry={id:uid(),username,name:txt(body.name,100),
      department:txt(body.department,80)||(role==='admin'?'Manajemen':'Lainnya'),
      position:txt(body.position,100)||(role==='admin'?'Administrator Sistem':'Staf'),
      email:txt(body.email,160),phone:txt(body.phone,40),profilePhoto:'',
      passwordHash:hashPassword(password),role,status:'active',mustChangePassword:true,
      createdAt:now(),approvedAt:now()};
    db.users.push(entry);
    record(u.id,role==='admin'?'CREATE_ADMIN':'CREATE_USER',entry.id);
    return reply(res,201,{user:exposed(entry),message:role==='admin'
      ? 'Akun admin baru aktif. Password wajib diganti pada login pertama.'
      : 'Akun pegawai aktif dibuat. Password wajib diganti pada login pertama.'});
  }
  if (/^\/api\/users\/[^/]+\/edit$/.test(url.pathname)) {
    if (u.role !== 'admin') return fail(res,403,'Hanya admin yang dapat mengubah akun pengguna.');
    const id=url.pathname.split('/')[3];
    const target=db.users.find(x=>x.id===id);
    if (!target) return fail(res,404,'Akun pengguna tidak ditemukan.');
    if (target.id===u.id) return fail(res,403,'Kelola profil sendiri melalui menu Profil Saya.');
    const name=txt(body.name,100);
    const newPassword=body.password === undefined || body.password === null ? '' : String(body.password);
    const role=body.role === undefined ? target.role : txt(body.role,20);
    if (!['staff','admin'].includes(role)) return fail(res,400,'Peran akun tidak valid.');
    if (name.length < 3) return fail(res,400,'Nama pengguna minimal 3 karakter.');
    if (newPassword && (newPassword.length<8 || newPassword.length>128))
      return fail(res,400,'Password baru harus 8–128 karakter.');
    const roleChanged=role!==target.role;
    if (roleChanged && role==='admin' && target.status!=='active')
      return fail(res,400,'Hanya akun aktif yang dapat dijadikan admin.');
    if (roleChanged && target.role==='admin' && role==='staff' &&
        db.users.filter(x=>x.role==='admin' && x.status==='active').length<=1)
      return fail(res,409,'Admin aktif terakhir tidak dapat diturunkan menjadi pegawai.');
    const department=txt(body.department,80) || 'Lainnya';
    const position=txt(body.position,100) || 'Staf';
    const email=txt(body.email,160);
    const phone=txt(body.phone,40);
    target.name=name;target.department=department;target.position=position;
    target.email=email;target.phone=phone;
    if (roleChanged) {
      target.role=role;
      if (role==='admin') target.mustChangePassword=true;
    }
    if (newPassword) {
      target.passwordHash=hashPassword(newPassword);
      target.mustChangePassword=true;
    }
    if (newPassword || roleChanged)
      for (const [key,sess] of sessions) if (sess.userId===target.id) sessions.delete(key);
    record(u.id,roleChanged?(role==='admin'?'PROMOTE_ADMIN':'DEMOTE_ADMIN'):(newPassword?'ADMIN_RESET_PASSWORD':'ADMIN_EDIT_USER'),target.id);
    return reply(res,200,{user:userList(target),message:roleChanged
      ? (role==='admin'?'Akun berhasil dijadikan admin. Pengguna wajib login kembali dan mengganti password.':'Hak admin dicabut. Pengguna perlu login kembali.')
      : (newPassword?'Data akun diperbarui dan password direset. Pengguna wajib mengganti password saat login berikutnya.':'Data akun berhasil diperbarui.')});
  }
  if (url.pathname.startsWith('/api/users/') && url.pathname.endsWith('/status')) {
    if (u.role!=='admin') return fail(res,403,'Hanya admin yang dapat menyetujui akun.');
    const id=url.pathname.split('/')[3];
    const target=db.users.find(x=>x.id===id);
    if (!target || target.role==='admin') return fail(res,404,'Pegawai tidak ditemukan atau tidak dapat diubah.');
    if (!['active','rejected','disabled'].includes(body.status)) return fail(res,400,'Status tidak dikenal.');
    target.status=body.status;target.approvedAt=body.status==='active'?now():target.approvedAt;
    for (const [key,s] of sessions) if (s.userId===target.id && body.status!=='active') sessions.delete(key);
    record(u.id,'USER_STATUS_'+body.status.toUpperCase(),target.id);
    return reply(res,200,{user:exposed(target),message:'Status akun diperbarui.'});
  }
  if (/^\/api\/visits\/[^/]+\/(delete|restore)$/.test(url.pathname)) {
    if (u.role !== 'admin') return fail(res,403,'Hanya admin yang dapat menghapus atau memulihkan laporan.');
    const [, , , id, action] = url.pathname.split('/');
    const visit=db.visits.find(v=>v.id===id);
    if (!visit) return fail(res,404,'Laporan tidak ditemukan.');
    if (action==='delete') {
      if (visit.deletedAt) return fail(res,409,'Laporan sudah berada di Sampah.');
      visit.deletedAt=now();visit.deletedBy=u.id;
      record(u.id,'DELETE_VISIT',visit.id);
      return reply(res,200,{message:'Laporan dipindahkan ke Sampah dan dapat dipulihkan.'});
    }
    if (!visit.deletedAt) return fail(res,409,'Laporan tidak berada di Sampah.');
    delete visit.deletedAt;delete visit.deletedBy;
    record(u.id,'RESTORE_VISIT',visit.id);
    return reply(res,200,{message:'Laporan berhasil dipulihkan.'});
  }
  if (url.pathname === '/api/visits') {
    const visit=makeVisit(body,u);
    db.visits.push(visit);record(u.id,'CREATE_VISIT',visit.id);
    return reply(res,201,{visit,message:'Laporan berhasil disimpan.'});
  }
  if (url.pathname.startsWith('/api/visits/') && url.pathname.endsWith('/progress')) {
    const id=url.pathname.split('/')[3];
    const visit=db.visits.find(v=>v.id===id);
    if (!visit || visit.deletedAt) return fail(res,404,'Laporan tidak ditemukan.');
    if (visit.userId!==u.id && u.role!=='admin') return fail(res,403,'Anda tidak berhak menambahkan progres ini.');
    const message=txt(body.message,3500);
    if (message.length<5) return fail(res,400,'Tuliskan perkembangan minimal 5 karakter.');
    const channel=txt(body.channel,30)||'Lainnya';
    const progressStatus=txt(body.progressStatus||visit.progressStatus||'proses',30);
    if (!validChannels.includes(channel)||!validProgress.includes(progressStatus)) return fail(res,400,'Kanal atau status tidak valid.');
    const files=parseEvidence(body.evidence||[],4);
    if ((visit.evidence?.length||0)+(visit.updates||[]).reduce((n,x)=>n+(x.evidence?.length||0),0)+files.length>12)
      return fail(res,400,'Maksimal 12 lampiran untuk keseluruhan riwayat laporan.');
    if (!Array.isArray(visit.updates)) visit.updates=[];
    if(visit.updates.length>=100) return fail(res,400,'Riwayat sudah mencapai 100 update.');
    const followUpDate=txt(body.followUpDate,10);
    if(!isDay(followUpDate))return fail(res,400,'Tanggal tindak lanjut tidak valid.');
    const update={id:uid(),at:now(),actorId:u.id,actorName:u.name,channel,message,progressStatus,followUpDate,evidence:files};
    visit.updates.push(update);visit.progressStatus=progressStatus;
    if(followUpDate)visit.followUpDate=followUpDate;
    visit.updatedAt=now();record(u.id,'ADD_PROGRESS',visit.id);
    return reply(res,201,{update,message:'Perkembangan berhasil ditambahkan.'});
  }
  if (url.pathname.startsWith('/api/visits/') && url.pathname.endsWith('/update')) {
    const id=url.pathname.split('/')[3];
    const visit=db.visits.find(v=>v.id===id);
    if (!visit || visit.deletedAt) return fail(res,404,'Laporan tidak ditemukan.');
    if (visit.userId!==u.id && u.role!=='admin') return fail(res,403,'Tidak berhak mengedit laporan ini.');
    if (visit.status==='completed') return fail(res,403,'Laporan selesai tidak dapat diubah.');
    const updated=makeVisit(body,u,visit);
    Object.assign(visit,updated);record(u.id,'UPDATE_VISIT',visit.id);
    return reply(res,200,{visit,message:'Laporan berhasil diperbarui.'});
  }
  return fail(res,404,'Endpoint tidak ditemukan.');
}
const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/index.html')) {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'geolocation=(self), camera=(self)'});
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (req.method==='GET' && url.pathname==='/favicon.ico') {res.writeHead(204);return res.end();}
    if (!url.pathname.startsWith('/api/')) return fail(res,404,'Halaman tidak ditemukan.');
    const u=currentUser(req);
    if (req.method==='GET') return handleGet(req,res,url,u);
    if (req.method==='POST') return await handlePost(req,res,url,u);
    return fail(res,405,'Metode tidak didukung.');
  } catch (e) {
    if (!res.headersSent && !res.destroyed) fail(res,e.status||500,e.status?e.message:'Terjadi kesalahan pada server.');
    if (!e.status) console.error(e);
  }
});
server.listen(PORT,HOST,()=>console.log(`ARU Visit CRM berjalan di http://${HOST}:${PORT}`));
setInterval(()=>{const t=Date.now();for (const [k,v] of sessions) if(v.expiresAt<t) sessions.delete(k);for(const [k,v] of rate) if(!v.length || t-v[v.length-1]>3600000) rate.delete(k)},15*60*1000).unref();