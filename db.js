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

function initDb() {
  const db = getDb();

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

module.exports = {
  getDb,
  initDb,
};
