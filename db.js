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

    function safeAddColumn(columnDef) {
      db.run(`ALTER TABLE sources ADD COLUMN ${columnDef}`, (err) => {
        if (err && !String(err.message).toLowerCase().includes('duplicate column')) {
          console.error('Error adding column to sources:', columnDef, err);
        }
      });
    }

    safeAddColumn('targetIndustry TEXT');
    safeAddColumn('companySize TEXT');
    safeAddColumn('roleFocus TEXT');
    safeAddColumn('mainAngle TEXT');

    function safeAddProspectColumn(columnDef) {
      db.run(`ALTER TABLE prospects ADD COLUMN ${columnDef}`, (err) => {
        if (err && !String(err.message).toLowerCase().includes('duplicate column')) {
          console.error('Error adding column to prospects:', columnDef, err);
        }
      });
    }

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
        archivedAt TEXT,
        status TEXT NOT NULL DEFAULT 'uncontacted',
        ownerName TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT,
        lastContactedAt TEXT,
        FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE SET NULL
      )
    `);
    safeAddProspectColumn('archivedAt TEXT');

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

    db.run(`
      CREATE TABLE IF NOT EXISTS domains (
        domain TEXT PRIMARY KEY,
        raw_excerpt TEXT,
        lastFetchedAt TEXT,
        status TEXT,
        error TEXT
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

function updateSocialPostStatus(id, status) {
  return new Promise((resolve, reject) => {
    const validStatuses = ['draft', 'scheduled', 'sent', 'archived'];
    if (!validStatuses.includes(status)) {
      return reject(new Error('INVALID_STATUS'));
    }

    db.get(
      'SELECT * FROM social_posts WHERE id = ?',
      [id],
      (err, existing) => {
        if (err) return reject(err);
        if (!existing) return resolve(null);

        const nowIso = new Date().toISOString();
        const nextSentAt =
          status === 'sent' && !existing.sentAt ? nowIso : existing.sentAt || null;

        const sql = 'UPDATE social_posts SET status = ?, sentAt = ? WHERE id = ?';
        const params = [status, nextSentAt, id];

        db.run(sql, params, function (updateErr) {
          if (updateErr) {
            return reject(updateErr);
          }
          if (this.changes === 0) {
            return resolve(null);
          }

          db.get(
            'SELECT * FROM social_posts WHERE id = ?',
            [id],
            (err2, row) => {
              if (err2) return reject(err2);
              resolve(row || null);
            },
          );
        });
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

function getSourceById(id) {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT id, name, type, description, metadata, createdAt, targetIndustry, companySize, roleFocus, mainAngle
        FROM sources
        WHERE id = ?
      `,
      [id],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      },
    );
  });
}

function getDomainProfile(domain, cb) {
  db.get(
    `
      SELECT domain, raw_excerpt, lastFetchedAt, status, error
      FROM domains
      WHERE domain = ?
    `,
    [domain],
    (err, row) => {
      if (cb) return cb(err, row || null);
      if (err) throw err;
      return row || null;
    },
  );
}

function upsertDomainProfile(profile, cb) {
  const { domain, raw_excerpt, lastFetchedAt, status, error } = profile || {};

  db.run(
    `
      INSERT OR REPLACE INTO domains (domain, raw_excerpt, lastFetchedAt, status, error)
      VALUES (?, ?, ?, ?, ?)
    `,
    [domain, raw_excerpt || null, lastFetchedAt || null, status || null, error || null],
    (err) => {
      if (cb) return cb(err);
      if (err) throw err;
    },
  );
}

function updateSourceIcp(id, icpFields, cb) {
  const fields = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(icpFields, 'targetIndustry')) {
    fields.push('targetIndustry = ?');
    params.push(icpFields.targetIndustry ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(icpFields, 'companySize')) {
    fields.push('companySize = ?');
    params.push(icpFields.companySize ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(icpFields, 'roleFocus')) {
    fields.push('roleFocus = ?');
    params.push(icpFields.roleFocus ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(icpFields, 'mainAngle')) {
    fields.push('mainAngle = ?');
    params.push(icpFields.mainAngle ?? null);
  }

  if (fields.length === 0) {
    return cb ? cb(null, null) : null;
  }

  params.push(id);

  const sql = `UPDATE sources SET ${fields.join(', ')} WHERE id = ?`;

  db.run(sql, params, function (err) {
    if (err) {
      if (cb) return cb(err);
      throw err;
    }

    if (this.changes === 0) {
      if (cb) return cb(null, null);
      return null;
    }

    db.get(
      'SELECT * FROM sources WHERE id = ?',
      [id],
      (err2, row) => {
        if (cb) return cb(err2, row || null);
        if (err2) throw err2;
        return row || null;
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

function getCampaignById(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM campaigns WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      },
    );
  });
}

module.exports = {
  getDb,
  initDb,
  updateProspectStatus,
  updateSocialPostStatus,
  getProspectNotes,
  addProspectNote,
  getProspectById,
  getCampaignById,
  getSourceById,
  getDomainProfile,
  upsertDomainProfile,
  updateSourceIcp,
};
