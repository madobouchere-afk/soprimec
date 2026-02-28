const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'soprimec.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS biens (
    code TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    immeuble TEXT DEFAULT '',
    appartement TEXT DEFAULT '',
    adresse TEXT NOT NULL,
    ville TEXT DEFAULT 'Dakar',
    surface TEXT DEFAULT '',
    chambres TEXT DEFAULT '',
    loyer INTEGER NOT NULL DEFAULT 0,
    charges INTEGER DEFAULT 0,
    statut TEXT DEFAULT 'Vacant',
    proprietaire TEXT DEFAULT '',
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS locataires (
    code TEXT PRIMARY KEY,
    nom TEXT NOT NULL,
    telephone TEXT NOT NULL,
    email TEXT DEFAULT '',
    cni TEXT DEFAULT '',
    profession TEXT DEFAULT '',
    bien TEXT,
    dateEntree TEXT,
    bail TEXT DEFAULT '12',
    loyer INTEGER NOT NULL DEFAULT 0,
    caution INTEGER DEFAULT 0,
    statut TEXT DEFAULT 'Actif',
    contrat TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS paiements (
    numero TEXT PRIMARY KEY,
    locataire TEXT,
    periode TEXT NOT NULL,
    montant INTEGER NOT NULL DEFAULT 0,
    date TEXT,
    mode TEXT DEFAULT 'Especes',
    reference TEXT DEFAULT '',
    statut TEXT DEFAULT 'Paye'
  );

  CREATE TABLE IF NOT EXISTS charges (
    numero TEXT PRIMARY KEY,
    bien TEXT,
    type TEXT NOT NULL,
    date TEXT,
    montant INTEGER NOT NULL DEFAULT 0,
    fournisseur TEXT DEFAULT '',
    reference TEXT DEFAULT '',
    description TEXT DEFAULT '',
    statut TEXT DEFAULT 'Paye'
  );

  CREATE TABLE IF NOT EXISTS entretiens (
    numero TEXT PRIMARY KEY,
    bien TEXT,
    type TEXT NOT NULL,
    urgence TEXT DEFAULT 'Basse',
    dateDemande TEXT,
    datePrevue TEXT,
    prestataire TEXT DEFAULT '',
    cout INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    statut TEXT DEFAULT 'Planifie'
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nom TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: add reference column to charges if missing
try {
  db.prepare("SELECT reference FROM charges LIMIT 1").get();
} catch(e) {
  db.exec("ALTER TABLE charges ADD COLUMN reference TEXT DEFAULT ''");
  console.log('Migration: added reference column to charges');
}

// Seed demo data if empty
function seedDemoData() {
  const count = db.prepare('SELECT COUNT(*) as c FROM biens').get();
  if (count.c > 0) return;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const insertBien = db.prepare('INSERT INTO biens (code,type,immeuble,appartement,adresse,ville,surface,chambres,loyer,charges,statut,proprietaire,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertLoc = db.prepare('INSERT INTO locataires (code,nom,telephone,email,cni,profession,bien,dateEntree,bail,loyer,caution,statut) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertPay = db.prepare('INSERT INTO paiements (numero,locataire,periode,montant,date,mode,reference,statut) VALUES (?,?,?,?,?,?,?,?)');
  const insertCharge = db.prepare('INSERT INTO charges (numero,bien,type,date,montant,fournisseur,description,statut) VALUES (?,?,?,?,?,?,?,?)');
  const insertEnt = db.prepare('INSERT INTO entretiens (numero,bien,type,urgence,dateDemande,datePrevue,prestataire,cout,description,statut) VALUES (?,?,?,?,?,?,?,?,?,?)');

  const seed = db.transaction(() => {
    // Biens
    insertBien.run('B001','Appartement','Résidence Océan - Plateau','Appt A3','15 Rue Jules Ferry','Dakar','85','3',250000,15000,'Loué','M. Diallo','');
    insertBien.run('B002','Villa','Mermoz','','28 Avenue Bourguiba','Dakar','200','5',650000,35000,'Loué','Mme Ndiaye','Piscine');
    insertBien.run('B003','Studio','Résidence Liberté 6','Studio 1A','45 Rue 10','Dakar','35','1',120000,8000,'Vacant','M. Sarr','');
    insertBien.run('B004','Studio','Résidence Liberté 6','Studio 2B','45 Rue 10','Dakar','40','1',130000,8000,'Vacant','M. Sarr','');
    insertBien.run('B005','Appartement','Résidence Océan - Plateau','Appt B1','15 Rue Jules Ferry','Dakar','70','2',200000,12000,'Vacant','M. Diallo','');

    // Locataires
    const entree1 = new Date(y, m - 6, 1).toISOString().split('T')[0];
    const entree2 = new Date(y, m - 12, 1).toISOString().split('T')[0];
    insertLoc.run('L001','FALL Aïssatou','77 123 45 67','aissatou.fall@email.com','1234567890','Comptable','B001',entree1,'12',250000,500000,'Actif');
    insertLoc.run('L002','SECK Ibrahima','76 234 56 78','ibrahima.seck@email.com','0987654321','Ingénieur','B002',entree2,'24',650000,1300000,'Actif');

    // Paiements - L002: all paid 12 months
    let pnum = 1;
    for (let i = 11; i >= 0; i--) {
      const d = new Date(y, m - i, 5);
      const periode = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      insertPay.run('P' + String(pnum++).padStart(4, '0'), 'L002', periode, 650000, d.toISOString().split('T')[0], 'Virement', '', 'Payé');
    }
    // L001: only last 4 months paid
    for (let i = 3; i >= 0; i--) {
      const d = new Date(y, m - i, 5);
      const periode = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      insertPay.run('P' + String(pnum++).padStart(4, '0'), 'L001', periode, 250000, d.toISOString().split('T')[0], 'Espèces', '', 'Payé');
    }

    // Charges
    insertCharge.run('C0001','B001','Électricité/SENELEC',new Date(y,m-1,15).toISOString().split('T')[0],45000,'SENELEC','Facture mensuelle','Payé');
    insertCharge.run('C0002','B002','Eau/SDE',new Date(y,m-1,20).toISOString().split('T')[0],28000,'SDE','Facture mensuelle','Payé');

    // Entretiens
    insertEnt.run('INT001','B001','Plomberie','Moyenne',new Date(y,m-1,10).toISOString().split('T')[0],new Date(y,m-1,15).toISOString().split('T')[0],'Ets Diop',75000,'Réparation fuite salle de bain','Terminé');
  });

  seed();
  console.log('Demo data seeded.');
}

seedDemoData();

module.exports = db;
