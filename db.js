const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'leads-gen.sqlite');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function getDb() {
  ensureDataDir();
  return new sqlite3.Database(dbPath);
}

const db = getDb();

function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        description TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS prospects (
        id TEXT PRIMARY KEY,
        sourceId TEXT,
        companyName TEXT,
        contactName TEXT,
        role TEXT,
        email TEXT,
        phone TEXT,
        website TEXT,
        tags TEXT,
        status TEXT NOT NULL DEFAULT 'uncontacted',
        ownerName TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT,
        lastContactedAt TEXT,
        FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE SET NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS prospect_notes (
        id TEXT PRIMARY KEY,
        prospectId TEXT NOT NULL,
        type TEXT,
        note TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (prospectId) REFERENCES prospects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS outreach_steps (
        id TEXT PRIMARY KEY,
        prospectId TEXT NOT NULL,
        channel TEXT,
        stepOrder INTEGER,
        title TEXT,
        bodyTemplate TEXT,
        scheduledAt TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        completedAt TEXT,
        FOREIGN KEY (prospectId) REFERENCES prospects(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT,
        targetDescription TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        startDate TEXT,
        endDate TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id TEXT PRIMARY KEY,
        campaignId TEXT,
        channel TEXT,
        content TEXT NOT NULL,
        tone TEXT,
        scheduledFor TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        publishedAt TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE SET NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS post_metrics (
        id TEXT PRIMARY KEY,
        postId TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        leadsGenerated INTEGER DEFAULT 0,
        notes TEXT,
        capturedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (postId) REFERENCES social_posts(id) ON DELETE CASCADE
      )
    `);
  });

  return db;
}

function updateProspectStatus(id, status) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE prospects SET status = ? WHERE id = ?',
      [status, id],
      function updateCallback(err) {
        if (err) return reject(err);
        if (this.changes === 0) return resolve(null);

        db.get(
          'SELECT * FROM prospects WHERE id = ?',
          [id],
          (err2, row) => {
            if (err2) return reject(err2);
            resolve(row || null);
          },
        );
      },
    );
  });
}

function getProspectById(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM prospects WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      },
    );
  });
}

function getProspectNotes(prospectId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        id,
        prospectId AS prospectId,
        note AS content,
        createdAt AS createdAt
      FROM prospect_notes
      WHERE prospectId = ?
      ORDER BY datetime(createdAt) DESC
      `,
      [prospectId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      },
    );
  });
}

function addProspectNote(prospectId, content) {
  return new Promise((resolve, reject) => {
    const id = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    db.run(
      `
      INSERT INTO prospect_notes (id, prospectId, note)
      VALUES (?, ?, ?)
      `,
      [id, prospectId, content],
      function insertNoteCallback(err) {
        if (err) return reject(err);

        db.get(
          `
          SELECT
            id,
            prospectId AS prospectId,
            note AS content,
            createdAt AS createdAt
          FROM prospect_notes
          WHERE id = ?
          `,
          [id],
          (err2, row) => {
            if (err2) return reject(err2);
            resolve(row);
          },
        );
      },
    );
  });
}

module.exports = {
  getDb,
  initDb,
  updateProspectStatus,
  getProspectNotes,
  addProspectNote,
  getProspectById,
};
