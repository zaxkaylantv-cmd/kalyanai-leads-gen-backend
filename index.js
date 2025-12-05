require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const {
  initDb,
  updateProspectStatus,
  updateSocialPostStatus,
  getProspectNotes,
  addProspectNote,
  getProspectById,
  getCampaignById,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3004;
const LEADDESK_API_BASE = process.env.LEADDESK_API_BASE || 'http://127.0.0.1:3003';

app.use(cors());
app.use(express.json());

const db = initDb();
const openai =
  process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

function generateId(prefix) {
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}_${random}`;
}

async function generateCampaignSuggestionsWithOpenAI(campaignId, fallbackSuggestions) {
  if (!openai || !process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY missing – using fallback suggestions.');
    return fallbackSuggestions;
  }

  try {
    const prompt = `
You are helping a B2B AI consultancy called Kalyan AI plan social posts for a lead generation campaign.

Kalyan AI offers bespoke hosted AI software to automate processes and streamline operations, saving time and money, improving customer experience and increasing profit without taking on new staff.

For campaign id: ${campaignId}

Create exactly 4 social post ideas:
1) LinkedIn - educational story style
2) Twitter (X) - short and punchy hook
3) Facebook - conversational with soft CTA
4) Instagram - caption style with emojis

For each suggestion, include:
- channel
- tone
- content
- imageIdea: a short description of the visual that should accompany the post (no more than 2 lines).

Return STRICT JSON ONLY, no extra text.
Shape:

{
  "suggestions": [
    { "channel": "linkedin",  "tone": "educational",    "content": "...", "imageIdea": "..." },
    { "channel": "twitter",   "tone": "punchy",         "content": "...", "imageIdea": "..." },
    { "channel": "facebook",  "tone": "conversational", "content": "...", "imageIdea": "..." },
    { "channel": "instagram", "tone": "caption",        "content": "...", "imageIdea": "..." }
  ]
}
`;

    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: prompt,
    });

    const output =
      response.output?.[0]?.content?.[0]?.text ||
      response.output?.[0]?.content?.[0]?.string;
    const raw = typeof output === 'string' ? output : '';

    if (!raw) {
      console.warn('OpenAI suggestions returned empty output, using fallback.');
      return fallbackSuggestions;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to parse OpenAI suggestions JSON, using fallback.', e);
      return fallbackSuggestions;
    }

    if (!parsed || !Array.isArray(parsed.suggestions)) {
      console.warn('OpenAI suggestions JSON shape invalid, using fallback.');
      return fallbackSuggestions;
    }

    const suggestions = parsed.suggestions
      .filter((s) => s && typeof s.content === 'string')
      .map((s) => ({
        channel: s.channel || 'linkedin',
        tone: s.tone || undefined,
        content: s.content,
        imageIdea: s.imageIdea || s.image_idea || null,
      }));

    return suggestions.length > 0 ? suggestions : fallbackSuggestions;
  } catch (err) {
    console.error('Error calling OpenAI for campaign suggestions:', err);
    return fallbackSuggestions;
  }
}

async function generateImageFromIdea(idea, channel) {
  if (!openai || !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_NOT_CONFIGURED');
  }

  const prompt = `
Create a clean, modern marketing visual for a B2B AI consultancy called Kalyan AI.

Kalyan AI offers bespoke hosted AI software to automate processes and streamline operations, saving time and money, improving customer experience and increasing profit without taking on new staff.

Channel: ${channel || 'generic'}
Visual idea: ${idea}

The style should be professional, minimal, and suitable for LinkedIn / Twitter / Facebook / Instagram.
Avoid any text inside the image (no big slogans or UI text), focus on strong, clear visuals.
`;

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1024x1024',
    n: 1,
  });

  const url =
    response.data &&
    Array.isArray(response.data) &&
    response.data[0] &&
    response.data[0].url
      ? response.data[0].url
      : null;

  if (!url) {
    throw new Error('NO_IMAGE_URL');
  }

  return url;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'kalyanai-leads-gen-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/sources', (req, res) => {
  db.all(
    `
      SELECT id, name, type, description, metadata, createdAt
      FROM sources
      ORDER BY datetime(createdAt) DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching sources:', err);
        return res.status(500).json({ error: 'Failed to fetch sources' });
      }
      return res.json(rows || []);
    },
  );
});

app.get('/sources/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    `
      SELECT *
      FROM sources
      WHERE id = ?
    `,
    [id],
    (err, row) => {
      if (err) {
        console.error('Failed to fetch source:', err);
        return res.status(500).json({ error: 'Failed to fetch source' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Source not found' });
      }
      return res.json(row);
    },
  );
});

app.post('/sources', (req, res) => {
  const { name, type, description, metadata } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = generateId('src');
  const metadataValue =
    metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : metadata || null;

  db.run(
    `
      INSERT INTO sources (id, name, type, description, metadata)
      VALUES (?, ?, ?, ?, ?)
    `,
    [id, name, type || null, description || null, metadataValue],
    function insertCallback(err) {
      if (err) {
        console.error('Error creating source:', err);
        return res.status(500).json({ error: 'Failed to create source' });
      }

      db.get(
        `
          SELECT id, name, type, description, metadata, createdAt
          FROM sources
          WHERE id = ?
        `,
        [id],
        (fetchErr, row) => {
          if (fetchErr) {
            console.error('Error fetching created source:', fetchErr);
            return res.status(500).json({ error: 'Failed to create source' });
          }
          return res.status(201).json(row);
        },
      );
    },
  );
});

app.get('/campaigns', (req, res) => {
  db.all(
    'SELECT * FROM campaigns ORDER BY createdAt DESC',
    [],
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch campaigns', err);
        return res.status(500).json({ error: 'Failed to fetch campaigns' });
      }
      res.json(rows);
    },
  );
});

app.post('/campaigns', (req, res) => {
  const { name, objective, targetDescription, status, startDate, endDate } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = generateId('camp');
  const trimmedName = name.trim();
  const desiredStatus =
    typeof status === 'string' && status.trim() !== '' ? status.trim() : 'draft';

  const sql = `
      INSERT INTO campaigns (id, name, objective, targetDescription, status, startDate, endDate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
  const params = [
    id,
    trimmedName,
    objective ?? null,
    targetDescription ?? null,
    desiredStatus,
    startDate ?? null,
    endDate ?? null,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('Failed to create campaign', err);
      return res.status(500).json({ error: 'Failed to create campaign' });
    }

    db.get(
      'SELECT * FROM campaigns WHERE id = ?',
      [id],
      (getErr, row) => {
        if (getErr) {
          console.error('Failed to fetch created campaign', getErr);
          return res.status(500).json({ error: 'Failed to fetch created campaign' });
        }
        res.status(201).json(row);
      },
    );
  });
});

app.post('/ai/campaigns/:id/suggest-posts', async (req, res) => {
  try {
    const { id } = req.params;

    const fallbackSuggestions = [
      {
        channel: 'linkedin',
        tone: 'educational',
        content:
          'Many service businesses are still juggling manual processes, even though it slows everything down. This campaign explores how bespoke hosted AI software can automate the boring work, save time and money, improve customer experience and increase profit without taking on new staff. If this resonates, comment or reply and I will share a simple outline for your context.',
        imageIdea:
          'Clean, modern illustration of a small business team looking at a simple AI dashboard showing time saved and happier customers.',
      },
      {
        channel: 'twitter',
        tone: 'punchy',
        content:
          'Too much manual work, not enough time, no budget to hire? Bespoke hosted AI software can automate your processes, improve CX and grow profit without extra headcount. This campaign is built to show real examples. #AI #automation',
        imageIdea:
          'Minimal graphic with the words "Less manual work, more growth" and a subtle AI icon.',
      },
      {
        channel: 'facebook',
        tone: 'conversational',
        content:
          'We are working with businesses who feel stuck between "too many manual tasks" and "not ready to hire more people". This campaign shares how bespoke hosted AI software can quietly automate core workflows, free your team up and make customers happier without increasing staff costs. Comment or message if you would like ideas for your own business.',
        imageIdea:
          'Friendly photo of a small team in a relaxed meeting, with a laptop screen showing an automation workflow.',
      },
      {
        channel: 'instagram',
        tone: 'caption',
        content:
          'Too many tasks. Not enough hours. No room to hire.\n\nBespoke hosted AI software can automate your processes, save time and money and level up your customer experience without growing the team.\n\nWant ideas for your business? DM "AI" and we will map a few quick wins.',
        imageIdea:
          'Before/after carousel concept: first slide cluttered to-do list, second slide clean screen with "AI-powered workflow" highlighted.',
      },
    ];

    const suggestions = await generateCampaignSuggestionsWithOpenAI(
      id,
      fallbackSuggestions,
    );

    return res.json(suggestions);
  } catch (err) {
    console.error('Error in POST /ai/campaigns/:id/suggest-posts', err);
    return res.status(500).json({ error: 'Failed to generate AI suggestions' });
  }
});

app.post('/ai/sources/:sourceId/enrich-preview', (req, res) => {
  const { sourceId } = req.params;

  db.all(
    'SELECT * FROM prospects WHERE sourceId = ? ORDER BY createdAt DESC',
    [sourceId],
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch prospects for enrichment', err);
        return res.status(500).json({ error: 'Failed to fetch prospects for enrichment' });
      }

      if (!rows || rows.length === 0) {
        return res.json([]);
      }

      const previews = rows.map((p) => {
        const companyName = p.companyName || null;
        const contactName = p.contactName || null;
        const email = p.email || null;
        const website = p.website || null;
        const status = p.status || null;

        const tagsText = `${p.tags || ''} ${p.companyName || ''} ${p.role || ''}`;
        const lower = tagsText.toLowerCase();

        let fitScore = 40;

        if (email && String(email).trim() !== '') {
          fitScore += 20;
        }
        if (p.phone && String(p.phone).trim() !== '') {
          fitScore += 10;
        }
        if (website && String(website).trim() !== '') {
          fitScore += 10;
        }

        if (lower.includes('agency') || lower.includes('marketing')) {
          fitScore += 10;
        } else if (lower.includes('consult') || lower.includes('advisory')) {
          fitScore += 10;
        } else if (lower.includes('account') || lower.includes('finance')) {
          fitScore += 10;
        }

        if (fitScore < 0) fitScore = 0;
        if (fitScore > 100) fitScore = 100;

        let fitLabel = 'cool';
        if (fitScore >= 80) {
          fitLabel = 'hot';
        } else if (fitScore >= 60) {
          fitLabel = 'warm';
        } else if (fitScore < 40) {
          fitLabel = 'cold';
        }

        let primaryPain = 'Too much manual work in sales, operations, and follow-up.';

        if (lower.includes('agency') || lower.includes('marketing')) {
          primaryPain = 'Juggling too many clients and campaigns manually.';
        } else if (lower.includes('account') || lower.includes('finance')) {
          primaryPain = 'Heavy admin around invoices, statements, and reconciliations.';
        } else if (lower.includes('consult') || lower.includes('advisory')) {
          primaryPain = "Lots of meetings and follow-ups that don't turn into structured actions.";
        }

        const nameForSummary = companyName || 'This company';

        const summary =
          `${nameForSummary} looks like a ${fitLabel} fit. ` +
          `They likely suffer from: ${primaryPain} ` +
          `AI-led automation and better workflows could free time and create cleaner follow-up.`;

        return {
          prospectId: p.id,
          companyName,
          contactName,
          email,
          website,
          status,
          fitScore,
          fitLabel,
          primaryPain,
          summary,
        };
      });

      res.json(previews);
    },
  );
});

app.post('/ai/image-from-idea', async (req, res) => {
  try {
    const { idea, channel } = req.body || {};

    if (!idea || typeof idea !== 'string' || !idea.trim()) {
      return res.status(400).json({ error: 'idea is required' });
    }

    try {
      const imageUrl = await generateImageFromIdea(idea.trim(), channel);
      return res.json({ imageUrl });
    } catch (err) {
      if (err && err.message === 'OPENAI_NOT_CONFIGURED') {
        console.error('OpenAI not configured for image generation');
        return res.status(500).json({ error: 'AI image generation is not configured' });
      }
      console.error('Error generating image from idea:', err);
      return res.status(500).json({ error: 'Failed to generate image' });
    }
  } catch (err) {
    console.error('Error in POST /ai/image-from-idea', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/social-posts', (req, res) => {
  const { campaignId } = req.query;

  let sql = 'SELECT * FROM social_posts';
  const params = [];

  if (campaignId && typeof campaignId === 'string' && campaignId.trim() !== '') {
    sql += ' WHERE campaignId = ?';
    params.push(campaignId.trim());
  }

  sql += ' ORDER BY createdAt DESC';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch social posts', err);
      return res.status(500).json({ error: 'Failed to fetch social posts' });
    }
    res.json(rows);
  });
});

app.post('/social-posts', (req, res) => {
  const {
    campaignId,
    channel,
    content,
    tone,
    scheduledFor,
    status,
  } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: 'content is required' });
  }

  const id = generateId('post');
  const finalChannel =
    typeof channel === 'string' && channel.trim() !== '' ? channel.trim() : 'linkedin';
  const finalStatus =
    typeof status === 'string' && status.trim() !== '' ? status.trim() : 'draft';

  const sql = `
      INSERT INTO social_posts (
        id,
        campaignId,
        channel,
        content,
        tone,
        scheduledFor,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

  const params = [
    id,
    campaignId ?? null,
    finalChannel,
    content.trim(),
    tone ?? null,
    scheduledFor ?? null,
    finalStatus,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('Failed to create social post', err);
      return res.status(500).json({ error: 'Failed to create social post' });
    }

    db.get(
      'SELECT * FROM social_posts WHERE id = ?',
      [id],
      (getErr, row) => {
        if (getErr) {
          console.error('Failed to fetch created social post', getErr);
          return res.status(500).json({ error: 'Failed to fetch created social post' });
        }
        res.status(201).json(row);
      },
    );
  });
});

app.patch('/social-posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'status is required' });
    }

    try {
      const updated = await updateSocialPostStatus(id, status);
      if (!updated) {
        return res.status(404).json({ error: 'Social post not found' });
      }
      return res.json(updated);
    } catch (err) {
      if (err && err.message === 'INVALID_STATUS') {
        return res
          .status(400)
          .json({ error: 'Invalid status value for social post' });
      }
      console.error('Error in updateSocialPostStatus:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  } catch (err) {
    console.error('Error in PATCH /social-posts/:id', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/prospects', (req, res) => {
  const { status, sourceId, ownerName, search } = req.query;

  const whereClauses = [];
  const params = [];

  if (status && typeof status === 'string' && status.trim() !== '') {
    whereClauses.push('status = ?');
    params.push(status.trim());
  }

  if (sourceId && typeof sourceId === 'string' && sourceId.trim() !== '') {
    whereClauses.push('sourceId = ?');
    params.push(sourceId.trim());
  }

  if (ownerName && typeof ownerName === 'string' && ownerName.trim() !== '') {
    whereClauses.push('ownerName = ?');
    params.push(ownerName.trim());
  }

  if (search && typeof search === 'string' && search.trim() !== '') {
    const like = `%${search.trim()}%`;
    whereClauses.push('(companyName LIKE ? OR contactName LIKE ? OR email LIKE ?)');
    params.push(like, like, like);
  }

  let sql = 'SELECT * FROM prospects';

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  sql += ' ORDER BY createdAt DESC';

  db.all(
    sql,
    params,
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch prospects:', err);
        return res.status(500).json({ error: 'Failed to fetch prospects' });
      }
      return res.json(rows || []);
    },
  );
});

app.get('/prospects/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    `
      SELECT
        id,
        sourceId,
        companyName,
        contactName,
        role,
        email,
        phone,
        website,
        tags,
        status,
        ownerName,
        createdAt,
        updatedAt,
        lastContactedAt
      FROM prospects
      WHERE id = ?
    `,
    [id],
    (err, row) => {
      if (err) {
        console.error('Failed to fetch prospect:', err);
        return res.status(500).json({ error: 'Failed to fetch prospect' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Prospect not found' });
      }
      return res.json(row);
    },
  );
});

app.post('/prospects', (req, res) => {
  const {
    sourceId,
    companyName,
    contactName,
    role,
    email,
    phone,
    website,
    tags,
    status,
    ownerName,
  } = req.body || {};

  const id = generateId('pros');
  const tagsValue = Array.isArray(tags) ? tags.join(',') : tags || null;
  const statusValue = status || 'uncontacted';

  db.run(
    `
      INSERT INTO prospects (
        id,
        sourceId,
        companyName,
        contactName,
        role,
        email,
        phone,
        website,
        tags,
        status,
        ownerName
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      sourceId || null,
      companyName || null,
      contactName || null,
      role || null,
      email || null,
      phone || null,
      website || null,
      tagsValue,
      statusValue,
      ownerName || null,
    ],
    function insertProspectCallback(err) {
      if (err) {
        console.error('Error creating prospect:', err);
        return res.status(500).json({ error: 'Failed to create prospect' });
      }

      db.get(
        `
          SELECT
            id,
            sourceId,
            companyName,
            contactName,
            role,
            email,
            phone,
            website,
            tags,
            status,
            ownerName,
            createdAt,
            updatedAt,
            lastContactedAt
          FROM prospects
          WHERE id = ?
        `,
        [id],
        (fetchErr, row) => {
          if (fetchErr) {
            console.error('Error fetching created prospect:', fetchErr);
            return res.status(500).json({ error: 'Failed to create prospect' });
          }
          return res.status(201).json(row);
        },
      );
    },
  );
});

app.patch('/prospects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'status is required' });
    }

    const allowedStatuses = ['uncontacted', 'contacted', 'qualified', 'bad-fit'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const updated = await updateProspectStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Prospect not found' });
    }

    return res.json(updated);
  } catch (err) {
    console.error('Error in PATCH /prospects/:id', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/prospects/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const notes = await getProspectNotes(id);
    return res.json(notes);
  } catch (err) {
    console.error('Error in GET /prospects/:id/notes', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/prospects/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    const note = await addProspectNote(id, content.trim());
    return res.status(201).json(note);
  } catch (err) {
    console.error('Error in POST /prospects/:id/notes', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/prospects/:id/push-to-leaddesk', async (req, res) => {
  try {
    const { id } = req.params;

    const prospect = await getProspectById(id);
    if (!prospect) {
      return res.status(404).json({ error: 'Prospect not found' });
    }

    const body = {
      name: prospect.contactName || prospect.companyName || 'Lead from Lead Gen',
      company: prospect.companyName || prospect.contactName || 'Lead Gen Prospect',
      email: prospect.email || null,
      phone: prospect.phone || null,
      value: null,
      source: prospect.sourceId || 'lead-gen',
      createdAt: prospect.createdAt || new Date().toISOString(),
      address: null,
      ownerName:
        prospect.ownerName && typeof prospect.ownerName === 'string' && prospect.ownerName.trim()
          ? prospect.ownerName.trim()
          : 'Unassigned',
    };

    const response = await fetch(`${LEADDESK_API_BASE}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Lead Desk create lead failed', response.status, text);
      return res.status(502).json({
        error: 'Failed to create lead in Lead Desk',
        status: response.status,
      });
    }

    const leaddeskLead = await response.json();

    return res.status(201).json({
      prospect,
      leaddeskLead,
    });
  } catch (err) {
    console.error('Error in POST /prospects/:id/push-to-leaddesk', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/sources/:sourceId/prospects/bulk', (req, res) => {
  const { sourceId } = req.params;
  const { prospects } = req.body || {};

  if (!Array.isArray(prospects) || prospects.length === 0) {
    return res.status(400).json({ error: 'prospects array is required' });
  }

  const validProspects = [];

  for (const raw of prospects) {
    if (!raw || typeof raw !== 'object') continue;

    const {
      companyName,
      contactName,
      role,
      email,
      phone,
      website,
      tags,
      status,
      ownerName,
    } = raw;

    const hasIdentifier =
      (companyName && String(companyName).trim() !== '') ||
      (contactName && String(contactName).trim() !== '') ||
      (email && String(email).trim() !== '');

    if (!hasIdentifier) {
      continue;
    }

    const id = generateId('pros');

    let tagsString = null;
    if (Array.isArray(tags)) {
      tagsString = tags.join(',');
    } else if (typeof tags === 'string') {
      tagsString = tags;
    }

    const finalStatus =
      typeof status === 'string' && status.trim() !== ''
        ? status.trim()
        : 'uncontacted';

    validProspects.push({
      id,
      sourceId: sourceId || null,
      companyName: companyName ?? null,
      contactName: contactName ?? null,
      role: role ?? null,
      email: email ?? null,
      phone: phone ?? null,
      website: website ?? null,
      tags: tagsString,
      status: finalStatus,
      ownerName: ownerName ?? null,
    });
  }

  if (validProspects.length === 0) {
    return res.status(400).json({ error: 'No valid prospects to import' });
  }

  db.serialize(() => {
    const insertSql = `
        INSERT INTO prospects (
          id,
          sourceId,
          companyName,
          contactName,
          role,
          email,
          phone,
          website,
          tags,
          status,
          ownerName
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

    const stmt = db.prepare(insertSql);

    try {
      for (const p of validProspects) {
        stmt.run(
          p.id,
          p.sourceId,
          p.companyName,
          p.contactName,
          p.role,
          p.email,
          p.phone,
          p.website,
          p.tags,
          p.status,
          p.ownerName,
        );
      }

      stmt.finalize(err => {
        if (err) {
          console.error('Failed to bulk import prospects (finalize)', err);
          return res.status(500).json({ error: 'Failed to bulk import prospects' });
        }

        const ids = validProspects.map(p => p.id);
        const placeholders = ids.map(() => '?').join(',');

        db.all(
          `SELECT * FROM prospects WHERE id IN (${placeholders})`,
          ids,
          (selectErr, rows) => {
            if (selectErr) {
              console.error('Failed to fetch imported prospects', selectErr);
              return res.status(500).json({ error: 'Failed to bulk import prospects' });
            }
            res.status(201).json(rows);
          },
        );
      });
    } catch (e) {
      console.error('Failed to bulk import prospects', e);
      try {
        stmt.finalize();
      } catch (_) {
        // ignore
      }
      return res.status(500).json({ error: 'Failed to bulk import prospects' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Lead Generation backend listening on port ${PORT}`);
});
