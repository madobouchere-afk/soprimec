const express = require('express');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'soprimec-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
  }
}));

// Create default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, nom, role) VALUES (?, ?, ?, ?)')
    .run('admin', hash, 'Administrateur', 'admin');
  console.log('Default admin created: admin / admin123');
}

// Serve login page (no auth needed)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Auth API routes (no auth needed)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.nom = user.nom;
  res.json({ ok: true, nom: user.nom, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  res.json({ username: req.session.username, nom: req.session.nom, role: req.session.role });
});

// Auth middleware — protect everything below
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  // For API calls, return 401
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autorisé' });
  // For page requests, redirect to login
  res.redirect('/login');
}

// Static files for logged-in users only (main app)
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Protect all /api routes (except auth ones above)
app.use('/api', requireAuth);

// Uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, 'contrat_' + req.params.code + '.pdf')
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Seuls les fichiers PDF sont acceptés'));
  }
});

// ===== HELPER: next code =====
function nextCode(table, prefix, field) {
  const row = db.prepare(`SELECT ${field} FROM ${table} ORDER BY ${field} DESC LIMIT 1`).get();
  if (!row) return prefix + '001';
  const m = row[field].match(/\d+/);
  const num = m ? parseInt(m[0]) + 1 : 1;
  const pad = prefix === 'P' || prefix === 'C' ? 4 : prefix === 'INT' ? 3 : 3;
  return prefix + String(num).padStart(pad, '0');
}

// ===== HELPER: month name =====
function getMoisNom(m) {
  return ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'][m];
}

// ===== HELPER: arrieres for a locataire =====
function getArrieres(loc) {
  if (loc.statut !== 'Actif') return { moisImpayes: [], total: 0 };
  const paiements = db.prepare("SELECT periode FROM paiements WHERE locataire = ? AND statut = 'Payé'").all(loc.code);
  const paidPeriodes = new Set(paiements.map(p => p.periode));
  const now = new Date();
  const entree = new Date(loc.dateEntree);
  const moisImpayes = [];
  const d = new Date(entree.getFullYear(), entree.getMonth(), 1);
  const finMois = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= finMois) {
    const periode = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!paidPeriodes.has(periode)) {
      moisImpayes.push({ periode, mois: getMoisNom(d.getMonth()) + ' ' + d.getFullYear() });
    }
    d.setMonth(d.getMonth() + 1);
  }
  return { moisImpayes, total: moisImpayes.length * loc.loyer };
}

// ==================== BIENS ====================
app.get('/api/biens', (req, res) => {
  res.json(db.prepare('SELECT * FROM biens').all());
});

app.post('/api/biens', (req, res) => {
  const b = req.body;
  const code = nextCode('biens', 'B', 'code');
  db.prepare('INSERT INTO biens (code,type,immeuble,appartement,adresse,ville,surface,chambres,loyer,charges,statut,proprietaire,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, b.type, b.immeuble || '', b.appartement || '', b.adresse, b.ville || 'Dakar', b.surface || '', b.chambres || '', b.loyer || 0, b.charges || 0, b.statut || 'Vacant', b.proprietaire || '', b.notes || '');
  res.json({ code });
});

app.delete('/api/biens/:code', (req, res) => {
  const active = db.prepare("SELECT COUNT(*) as c FROM locataires WHERE bien = ? AND statut = 'Actif'").get(req.params.code);
  if (active.c > 0) return res.status(400).json({ error: 'Bien loué à un locataire actif' });
  db.prepare('DELETE FROM biens WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ==================== LOCATAIRES ====================
app.get('/api/locataires', (req, res) => {
  res.json(db.prepare('SELECT * FROM locataires').all());
});

app.get('/api/locataires/:code', (req, res) => {
  const loc = db.prepare('SELECT * FROM locataires WHERE code = ?').get(req.params.code);
  if (!loc) return res.status(404).json({ error: 'Non trouvé' });
  res.json(loc);
});

app.post('/api/locataires', (req, res) => {
  const l = req.body;
  const code = nextCode('locataires', 'L', 'code');
  db.prepare('INSERT INTO locataires (code,nom,telephone,email,cni,profession,bien,dateEntree,bail,loyer,caution,statut) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, l.nom, l.telephone, l.email || '', l.cni || '', l.profession || '', l.bien, l.dateEntree || '', l.bail || '12', l.loyer || 0, l.caution || 0, 'Actif');
  // Set bien as Loué
  db.prepare("UPDATE biens SET statut = 'Loué' WHERE code = ?").run(l.bien);
  res.json({ code });
});

app.delete('/api/locataires/:code', (req, res) => {
  const loc = db.prepare('SELECT * FROM locataires WHERE code = ?').get(req.params.code);
  if (loc) {
    db.prepare("UPDATE biens SET statut = 'Vacant' WHERE code = ?").run(loc.bien);
    // Delete contract file
    const filepath = path.join(uploadsDir, 'contrat_' + req.params.code + '.pdf');
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
  db.prepare('DELETE FROM locataires WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ==================== PAIEMENTS ====================
app.get('/api/paiements', (req, res) => {
  res.json(db.prepare('SELECT * FROM paiements').all());
});

app.post('/api/paiements', (req, res) => {
  const p = req.body;
  const numero = nextCode('paiements', 'P', 'numero');
  db.prepare('INSERT INTO paiements (numero,locataire,periode,montant,date,mode,reference,statut) VALUES (?,?,?,?,?,?,?,?)')
    .run(numero, p.locataire, p.periode, p.montant || 0, p.date || '', p.mode || 'Espèces', p.reference || '', p.statut || 'Payé');
  res.json({ numero });
});

app.delete('/api/paiements/:numero', (req, res) => {
  db.prepare('DELETE FROM paiements WHERE numero = ?').run(req.params.numero);
  res.json({ ok: true });
});

// ==================== CHARGES ====================
app.get('/api/charges', (req, res) => {
  res.json(db.prepare('SELECT * FROM charges').all());
});

app.post('/api/charges', (req, res) => {
  const c = req.body;
  const numero = nextCode('charges', 'C', 'numero');
  db.prepare('INSERT INTO charges (numero,bien,type,date,montant,fournisseur,description,statut) VALUES (?,?,?,?,?,?,?,?)')
    .run(numero, c.bien, c.type, c.date || '', c.montant || 0, c.fournisseur || '', c.description || '', c.statut || 'Payé');
  res.json({ numero });
});

app.delete('/api/charges/:numero', (req, res) => {
  db.prepare('DELETE FROM charges WHERE numero = ?').run(req.params.numero);
  res.json({ ok: true });
});

// ==================== ENTRETIENS ====================
app.get('/api/entretiens', (req, res) => {
  res.json(db.prepare('SELECT * FROM entretiens').all());
});

app.post('/api/entretiens', (req, res) => {
  const e = req.body;
  const numero = nextCode('entretiens', 'INT', 'numero');
  db.prepare('INSERT INTO entretiens (numero,bien,type,urgence,dateDemande,datePrevue,prestataire,cout,description,statut) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(numero, e.bien, e.type, e.urgence || 'Basse', e.dateDemande || '', e.datePrevue || '', e.prestataire || '', e.cout || 0, e.description || '', e.statut || 'Planifié');
  res.json({ numero });
});

app.delete('/api/entretiens/:numero', (req, res) => {
  db.prepare('DELETE FROM entretiens WHERE numero = ?').run(req.params.numero);
  res.json({ ok: true });
});

// ==================== CONTRATS PDF ====================
app.post('/api/contrats/:code', upload.single('contrat'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  db.prepare('UPDATE locataires SET contrat = ? WHERE code = ?').run(req.file.originalname, req.params.code);
  res.json({ ok: true, filename: req.file.originalname });
});

app.get('/api/contrats/:code', (req, res) => {
  const filepath = path.join(uploadsDir, 'contrat_' + req.params.code + '.pdf');
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Contrat non trouvé' });
  if (req.query.download === 'true') {
    const loc = db.prepare('SELECT nom, contrat FROM locataires WHERE code = ?').get(req.params.code);
    const filename = loc ? 'Contrat_' + loc.nom.replace(/\s/g, '_') + '.pdf' : 'contrat.pdf';
    res.download(filepath, filename);
  } else {
    res.sendFile(filepath);
  }
});

app.delete('/api/contrats/:code', (req, res) => {
  const filepath = path.join(uploadsDir, 'contrat_' + req.params.code + '.pdf');
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  db.prepare('UPDATE locataires SET contrat = NULL WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ==================== DASHBOARD ====================
app.get('/api/dashboard', (req, res) => {
  const biens = db.prepare('SELECT * FROM biens').all();
  const locs = db.prepare("SELECT * FROM locataires WHERE statut = 'Actif'").all();
  const loues = biens.filter(b => b.statut === 'Loué').length;
  const taux = biens.length ? Math.round(loues / biens.length * 100) : 0;
  const loyersAttendus = locs.reduce((s, l) => s + l.loyer, 0);

  let totalArrieres = 0;
  const arList = [];
  locs.forEach(l => {
    const arr = getArrieres(l);
    if (arr.total > 0) {
      totalArrieres += arr.total;
      const bien = biens.find(b => b.code === l.bien);
      arList.push({ loc: l, bien, arr });
    }
  });

  const rappelsCount = getRappels(locs, biens).length;

  res.json({
    totalBiens: biens.length, loues, taux, loyersAttendus,
    locatairesActifs: locs.length, totalArrieres, rappelsCount, arList
  });
});

// ==================== ARRIERES ====================
app.get('/api/arrieres', (req, res) => {
  const locs = db.prepare("SELECT * FROM locataires WHERE statut = 'Actif'").all();
  const result = locs.map(l => ({ loc: l, ...getArrieres(l) })).filter(r => r.total > 0);
  res.json(result);
});

app.get('/api/arrieres/:code', (req, res) => {
  const loc = db.prepare('SELECT * FROM locataires WHERE code = ?').get(req.params.code);
  if (!loc) return res.status(404).json({ error: 'Non trouvé' });
  res.json(getArrieres(loc));
});

// ==================== RAPPELS ====================
function getRappels(locs, biens) {
  if (!locs) locs = db.prepare("SELECT * FROM locataires WHERE statut = 'Actif'").all();
  if (!biens) biens = db.prepare('SELECT * FROM biens').all();
  const now = new Date();
  const jour = now.getDate();
  const moisActuel = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const rappels = [];

  locs.forEach(loc => {
    const arr = getArrieres(loc);
    const paiements = db.prepare("SELECT periode FROM paiements WHERE locataire = ? AND statut = 'Payé'").all(loc.code);
    const moisActuelPaye = paiements.some(p => p.periode === moisActuel);

    // Type 2: arriérés
    if (arr.moisImpayes.length > 0) {
      const arrieresSansMoisActuel = arr.moisImpayes.filter(m => m.periode !== moisActuel);
      if (arrieresSansMoisActuel.length > 0) {
        const moisListe = arrieresSansMoisActuel.map(m => m.mois).join(', ');
        rappels.push({
          loc, type: 'arrieres', badge: 'badge-danger', label: 'Arriérés',
          montant: arrieresSansMoisActuel.length * loc.loyer, mois: moisListe,
          message: `Bonjour Mr/Mme ${loc.nom}, l'agence SOPRIMEC vous rappelle que vous devez solder vos arriérés des mois de ${moisListe} avant le 05 du mois en cours. Merci de vous rapprocher de l'agence au 78 893 27 87.`
        });
      }
    }
    // Type 1: current month unpaid after 15th
    if (!moisActuelPaye && jour >= 15) {
      const arrieresSansMoisActuel = arr.moisImpayes.filter(m => m.periode !== moisActuel);
      if (arrieresSansMoisActuel.length === 0) {
        const moisNom = getMoisNom(now.getMonth()) + ' ' + now.getFullYear();
        rappels.push({
          loc, type: 'courant', badge: 'badge-warning', label: 'Mois courant',
          montant: loc.loyer, mois: moisNom,
          message: `Bonjour Mr/Mme ${loc.nom}, l'agence SOPRIMEC vous rappelle que le loyer du mois de ${moisNom} est à régler avant le 05. Merci de vous rapprocher de l'agence au 78 893 27 87.`
        });
      }
    }
  });
  return rappels;
}

app.get('/api/rappels', (req, res) => {
  res.json(getRappels());
});

// ==================== RAPPORTS ====================
app.get('/api/rapports/:periode', (req, res) => {
  const periode = req.params.periode;
  const [y, m] = periode.split('-').map(Number);
  const locs = db.prepare("SELECT * FROM locataires WHERE statut = 'Actif'").all();
  const paiements = db.prepare('SELECT * FROM paiements WHERE periode = ?').all(periode);
  const charges = db.prepare('SELECT * FROM charges WHERE date IS NOT NULL').all()
    .filter(c => { const d = new Date(c.date); return d.getFullYear() === y && d.getMonth() + 1 === m; });

  const loyersAttendus = locs.reduce((s, l) => s + l.loyer, 0);
  const loyersEncaisses = paiements.filter(p => p.statut === 'Payé').reduce((s, p) => s + p.montant, 0);
  const impayes = loyersAttendus - loyersEncaisses;
  const taux = loyersAttendus ? Math.round(loyersEncaisses / loyersAttendus * 100) : 0;
  const totalCharges = charges.reduce((s, c) => s + c.montant, 0);
  const net = loyersEncaisses - totalCharges;

  res.json({ loyersAttendus, loyersEncaisses, impayes, taux, totalCharges, net });
});

// ==================== EXPORT / IMPORT ====================
app.get('/api/export/json', (req, res) => {
  const data = {
    biens: db.prepare('SELECT * FROM biens').all(),
    locataires: db.prepare('SELECT * FROM locataires').all(),
    paiements: db.prepare('SELECT * FROM paiements').all(),
    charges: db.prepare('SELECT * FROM charges').all(),
    entretiens: db.prepare('SELECT * FROM entretiens').all()
  };
  const filename = 'soprimec_backup_' + new Date().toISOString().split('T')[0] + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename=' + filename);
  res.json(data);
});

app.post('/api/import/json', express.json({ limit: '50mb' }), (req, res) => {
  const data = req.body;
  const importTx = db.transaction(() => {
    if (data.biens) {
      db.prepare('DELETE FROM biens').run();
      const ins = db.prepare('INSERT INTO biens (code,type,immeuble,appartement,adresse,ville,surface,chambres,loyer,charges,statut,proprietaire,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      data.biens.forEach(b => ins.run(b.code, b.type, b.immeuble || '', b.appartement || '', b.adresse, b.ville || '', b.surface || '', b.chambres || '', b.loyer || 0, b.charges || 0, b.statut || '', b.proprietaire || '', b.notes || ''));
    }
    if (data.locataires) {
      db.prepare('DELETE FROM locataires').run();
      const ins = db.prepare('INSERT INTO locataires (code,nom,telephone,email,cni,profession,bien,dateEntree,bail,loyer,caution,statut,contrat) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      data.locataires.forEach(l => ins.run(l.code, l.nom, l.telephone, l.email || '', l.cni || '', l.profession || '', l.bien, l.dateEntree || '', l.bail || '', l.loyer || 0, l.caution || 0, l.statut || '', l.contrat || null));
    }
    if (data.paiements) {
      db.prepare('DELETE FROM paiements').run();
      const ins = db.prepare('INSERT INTO paiements (numero,locataire,periode,montant,date,mode,reference,statut) VALUES (?,?,?,?,?,?,?,?)');
      data.paiements.forEach(p => ins.run(p.numero, p.locataire, p.periode, p.montant || 0, p.date || '', p.mode || '', p.reference || '', p.statut || ''));
    }
    if (data.charges) {
      db.prepare('DELETE FROM charges').run();
      const ins = db.prepare('INSERT INTO charges (numero,bien,type,date,montant,fournisseur,description,statut) VALUES (?,?,?,?,?,?,?,?)');
      data.charges.forEach(c => ins.run(c.numero, c.bien, c.type, c.date || '', c.montant || 0, c.fournisseur || '', c.description || '', c.statut || ''));
    }
    if (data.entretiens) {
      db.prepare('DELETE FROM entretiens').run();
      const ins = db.prepare('INSERT INTO entretiens (numero,bien,type,urgence,dateDemande,datePrevue,prestataire,cout,description,statut) VALUES (?,?,?,?,?,?,?,?,?,?)');
      data.entretiens.forEach(e => ins.run(e.numero, e.bien, e.type, e.urgence || '', e.dateDemande || '', e.datePrevue || '', e.prestataire || '', e.cout || 0, e.description || '', e.statut || ''));
    }
  });
  importTx();
  res.json({ ok: true });
});

app.get('/api/export/csv', (req, res) => {
  const locs = db.prepare('SELECT * FROM locataires').all();
  const biens = db.prepare('SELECT * FROM biens').all();
  let csv = 'Code,Nom,Téléphone,Bien,Immeuble,Appartement,Adresse,Loyer,Arriérés,Statut\n';
  locs.forEach(l => {
    const b = biens.find(bi => bi.code === l.bien);
    const arr = getArrieres(l);
    csv += `${l.code},"${l.nom}",${l.telephone},${l.bien},"${b ? b.immeuble || '' : ''}","${b ? b.appartement || '' : ''}","${b ? b.adresse || '' : ''}",${l.loyer},${arr.total},${l.statut}\n`;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=soprimec_locataires.csv');
  res.send(csv);
});

// ==================== RESET ====================
app.post('/api/reset', (req, res) => {
  db.prepare('DELETE FROM entretiens').run();
  db.prepare('DELETE FROM charges').run();
  db.prepare('DELETE FROM paiements').run();
  db.prepare('DELETE FROM locataires').run();
  db.prepare('DELETE FROM biens').run();
  // Delete all uploaded files
  const files = fs.readdirSync(uploadsDir);
  files.forEach(f => fs.unlinkSync(path.join(uploadsDir, f)));
  res.json({ ok: true });
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SOPRIMEC running on http://0.0.0.0:${PORT}`);
});
