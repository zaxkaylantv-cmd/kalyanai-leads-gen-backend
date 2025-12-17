require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const {
  initDb,
  updateProspectStatus,
  updateSocialPostStatus,
  getProspectNotes,
  getNotesByProspectIds,
  addProspectNote,
  getProspectById,
  getCampaignById,
  getSourceById,
  getDomainProfile,
  upsertDomainProfile,
  updateSourceIcp,
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

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function normalizeName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed || null;
}

function extractDomainFromWebsiteOrEmail(website, email) {
  if (website && typeof website === 'string') {
    const value = website.trim();
    if (value) {
      try {
        const url = value.startsWith('http') ? value : `https://${value}`;
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./i, '');
        if (host) return host.toLowerCase();
      } catch (e) {
        // ignore invalid website
      }
    }
  }
  if (email && typeof email === 'string' && email.includes('@')) {
    const domainPart = email.split('@')[1]?.trim();
    if (domainPart) return domainPart.replace(/^www\./i, '').toLowerCase();
  }
  return null;
}

function checkDuplicateProspect({ normalizedEmail, normalizedDomain, normalizedContactName }) {
  return new Promise((resolve, reject) => {
    if (normalizedEmail) {
      db.get(
        'SELECT id, suppressedAt FROM prospects WHERE normalizedEmail = ? LIMIT 1',
        [normalizedEmail],
        (err, row) => {
          if (err) return reject(err);
          if (row) return resolve(row);
          if (normalizedDomain && normalizedContactName) {
            db.get(
              'SELECT id, suppressedAt FROM prospects WHERE normalizedDomain = ? AND normalizedContactName = ? LIMIT 1',
              [normalizedDomain, normalizedContactName],
              (err2, row2) => {
                if (err2) return reject(err2);
                return resolve(row2 || null);
              },
            );
          } else {
            return resolve(null);
          }
        },
      );
    } else if (normalizedDomain && normalizedContactName) {
      db.get(
        'SELECT id, suppressedAt FROM prospects WHERE normalizedDomain = ? AND normalizedContactName = ? LIMIT 1',
        [normalizedDomain, normalizedContactName],
        (err, row) => {
          if (err) return reject(err);
          return resolve(row || null);
        },
      );
    } else {
      resolve(null);
    }
  });
}

async function generateCampaignSuggestionsWithOpenAI(campaignId, fallbackSuggestions) {
  const extractJson = (text) => {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();
    cleaned = cleaned.replace(/```json\s*([\s\S]*?)```/gi, '$1');
    cleaned = cleaned.replace(/```\s*([\s\S]*?)```/gi, '$1');
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    const starts = [firstBrace, firstBracket].filter((v) => v >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    let depth = 0;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (start >= 0 && end > start) {
      return cleaned.slice(start, end);
    }
    return null;
  };
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
      const jsonString = extractJson(raw);
      parsed = jsonString ? JSON.parse(jsonString) : JSON.parse(raw);
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

function htmlToText(html, maxLength = 8000) {
  if (!html) return '';
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  let text = withoutScripts.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }
  return text;
}

function buildUrlFromDomain(domain) {
  if (!domain) return null;
  let d = domain.trim();
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) {
    d = `https://${d}`;
  }
  return d;
}

async function fetchAndCacheDomainProfile(domain) {
  const url = buildUrlFromDomain(domain);
  if (!url) {
    const invalidProfile = {
      domain,
      raw_excerpt: '',
      lastFetchedAt: new Date().toISOString(),
      status: 'invalid',
      error: 'invalid_domain',
    };

    await new Promise((resolve, reject) => {
      upsertDomainProfile(invalidProfile, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    return invalidProfile;
  }

  let raw_excerpt = '';
  let status = 'ok';
  let error = null;

  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      status = 'error';
      error = `HTTP ${res.status}`;
    } else {
      const html = await res.text();
      raw_excerpt = htmlToText(html);
    }
  } catch (err) {
    status = 'error';
    error = err.message || String(err);
  }

  const profile = {
    domain,
    raw_excerpt,
    lastFetchedAt: new Date().toISOString(),
    status,
    error,
  };

  await new Promise((resolve, reject) => {
    upsertDomainProfile(profile, (err2) => {
      if (err2) return reject(err2);
      resolve();
    });
  });

  return profile;
}

async function getOrFetchDomainProfile(domain) {
  if (!domain) return null;

  const existing = await new Promise((resolve, reject) => {
    getDomainProfile(domain, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });

  if (existing && existing.status === 'ok' && existing.raw_excerpt) {
    return existing;
  }

  return fetchAndCacheDomainProfile(domain);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'kalyanai-leads-gen-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/debug/domain-profile', async (req, res) => {
  try {
    const { domain } = req.query;
    if (!domain) {
      return res.status(400).json({ error: 'Missing domain query param' });
    }

    const profile = await getOrFetchDomainProfile(domain);
    if (!profile) {
      return res.status(404).json({ error: 'No profile for this domain' });
    }

    return res.json({
      domain: profile.domain,
      status: profile.status,
      lastFetchedAt: profile.lastFetchedAt,
      error: profile.error,
      raw_excerpt_length: profile.raw_excerpt ? profile.raw_excerpt.length : 0,
      raw_excerpt_preview: profile.raw_excerpt ? profile.raw_excerpt.slice(0, 500) : '',
    });
  } catch (err) {
    console.error('Error in /debug/domain-profile:', err);
    return res.status(500).json({ error: 'Failed to fetch domain profile' });
  }
});

app.get('/sources', (req, res) => {
  db.all(
    `
      SELECT id, name, type, description, metadata, createdAt, targetIndustry, companySize, roleFocus, mainAngle
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
  const {
    name,
    type,
    description,
    metadata,
    targetIndustry,
    companySize,
    roleFocus,
    mainAngle,
  } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = generateId('src');
  const metadataValue =
    metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : metadata || null;

  db.run(
    `
      INSERT INTO sources (id, name, type, description, metadata, targetIndustry, companySize, roleFocus, mainAngle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      name,
      type || null,
      description || null,
      metadataValue,
      targetIndustry || null,
      companySize || null,
      roleFocus || null,
      mainAngle || null,
    ],
    function insertCallback(err) {
      if (err) {
        console.error('Error creating source:', err);
        return res.status(500).json({ error: 'Failed to create source' });
      }

      db.get(
        `
          SELECT id, name, type, description, metadata, createdAt, targetIndustry, companySize, roleFocus, mainAngle
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

app.patch('/sources/:id', (req, res) => {
  const { id } = req.params;
  const {
    targetIndustry,
    companySize,
    roleFocus,
    mainAngle,
  } = req.body || {};

  const icpFields = {};

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'targetIndustry')) {
    icpFields.targetIndustry = targetIndustry;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'companySize')) {
    icpFields.companySize = companySize;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'roleFocus')) {
    icpFields.roleFocus = roleFocus;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'mainAngle')) {
    icpFields.mainAngle = mainAngle;
  }

  if (Object.keys(icpFields).length === 0) {
    return res.status(400).json({ error: 'No ICP fields provided' });
  }

  updateSourceIcp(id, icpFields, (err, updated) => {
    if (err) {
      console.error('Error updating source ICP:', err);
      return res.status(500).json({ error: 'Failed to update source' });
    }

    if (!updated) {
      return res.status(404).json({ error: 'Source not found' });
    }

    return res.json(updated);
  });
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

app.post('/ai/sources/:sourceId/enrich-preview', async (req, res) => {
  try {
    const { sourceId } = req.params;

    const prospects = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM prospects WHERE sourceId = ? AND suppressedAt IS NULL ORDER BY createdAt DESC',
        [sourceId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        },
      );
    });

    if (!prospects || prospects.length === 0) {
      return res.json([]);
    }

    let source = null;
    try {
      source = await getSourceById(sourceId);
    } catch (err) {
      console.error('Failed to fetch source for enrichment context', err);
    }

    const icpContextLines = [];
    if (source && source.name) icpContextLines.push(`Campaign/source name: ${source.name}.`);
    if (source && source.targetIndustry) icpContextLines.push(`Target industry: ${source.targetIndustry}.`);
    if (source && source.companySize) icpContextLines.push(`Typical company size: ${source.companySize}.`);
    if (source && source.roleFocus) icpContextLines.push(`Primary buyer persona / role focus: ${source.roleFocus}.`);
    if (source && source.mainAngle) icpContextLines.push(`Primary commercial angle: ${source.mainAngle}.`);

    const sourceIcpContext =
      icpContextLines.length > 0
        ? icpContextLines.join(' ')
        : 'No additional ICP context provided; assume common B2B pains around operations, sales process, and customer experience.';

    const getDomainForProspect = (prospect) => {
      if (prospect.website) {
        try {
          let url = prospect.website.trim();
          if (!/^https?:\/\//i.test(url)) {
            url = `https://${url}`;
          }
          const parsed = new URL(url);
          return parsed.hostname.replace(/^www\./i, '');
        } catch (err) {
          // ignore invalid website
        }
      }

      if (prospect.email && prospect.email.includes('@')) {
        const domainPart = prospect.email.split('@')[1].trim();
        if (domainPart) {
          return domainPart.replace(/^www\./i, '');
        }
      }

      return null;
    };

    const domainMap = new Map();
    for (const prospect of prospects) {
      const domain = getDomainForProspect(prospect);
      if (domain && !domainMap.has(domain)) {
        domainMap.set(domain, null);
      }
    }

    for (const domain of domainMap.keys()) {
      try {
        const profile = await getOrFetchDomainProfile(domain);
        domainMap.set(domain, profile || null);
      } catch (err) {
        console.error('Error fetching domain profile for', domain, err);
        domainMap.set(domain, null);
      }
    }

    const prospectIds = prospects.map((p) => p.id);
    let notesByProspect = new Map();
    try {
      notesByProspect = await getNotesByProspectIds(prospectIds);
    } catch (err) {
      console.error('Failed to fetch prospect notes for enrichment', err);
    }

    const buildNotesString = (prospectId) => {
      const notes = notesByProspect.get(prospectId) || [];
      if (!notes.length) return 'none available';
      const maxNotes = notes.slice(0, 5);
      const combined = maxNotes
        .map((n) => (n.content || '').trim())
        .filter(Boolean)
        .join(' | ');
      if (!combined) return 'none available';
      const maxLen = 1000;
      return combined.length > maxLen ? combined.slice(0, maxLen) : combined;
    };

    const buildHeuristicPreview = (p) => {
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
    };

    if (!openai || !process.env.OPENAI_API_KEY) {
      const previews = prospects.map((p) => buildHeuristicPreview(p));
      return res.json(previews);
    }

    const prospectBlocks = prospects
      .map((p) => {
        const domain = getDomainForProspect(p);
        const profile = domain ? domainMap.get(domain) : null;
        const websiteExcerpt =
          profile && profile.raw_excerpt ? profile.raw_excerpt.slice(0, 1500) : '';

        const safeExcerpt =
          websiteExcerpt && websiteExcerpt.trim() !== '' ? websiteExcerpt : 'none available';
        const notesText = buildNotesString(p.id);

        return [
          `PROSPECT_ID: ${p.id}`,
          `COMPANY_NAME: ${p.companyName || 'Unknown company'}`,
          `CONTACT_NAME: ${p.contactName || 'Unknown contact'}`,
          `EMAIL: ${p.email || 'Unknown email'}`,
          `WEBSITE: ${p.website || 'Unknown website'}`,
          `WEBSITE_DOMAIN: ${domain || 'none'}`,
          `WEBSITE_EXCERPT: "${safeExcerpt.replace(/"/g, '\\"')}"`,
          `NOTES: "${notesText.replace(/"/g, '\\"')}"`,
          '---',
        ].join('\n');
      })
      .join('\n');

    const systemPrompt = `
You are an assistant helping Kalyan AI assess B2B prospects for fit.
Return JSON ONLY, no extra text.
Rules:
- primaryPain must be a real business problem (manual processes/inefficiency, poor lead handling, weak operations, revenue leakage, poor customer experience).
- NEVER use or imply "lack of publicly available information", "limited online presence", "insufficient data", inability to research, or mention Google/LinkedIn/research limits.
- If website info is weak or missing, infer likely pains for this type of company; keep language neutral and do not comment on their online presence.
Tone and language constraints:
- Describe pains as opportunities to improve or streamline, not as failures. Use phrasing like "opportunity to streamline X", "may benefit from simplifying Y", "could reduce manual steps in Z", "may want better visibility into ...".
- Avoid harsh/judgemental words or phrases such as: inefficient, inefficiencies, poor, weak, broken, outdated, struggling, chaotic, disorganized, problematic, "issues with", "common in X industry", or "typical of X companies".
- primaryPain must focus on an underlying business process but be framed as an opportunity to improve (e.g. "Opportunity to streamline how they handle inbound leads", not "Their lead handling is inefficient").
- Any subject lines, summaries, or copy must not blame or criticise the company; position Kalyan AI as helping them streamline or get more from what they already do.
CAMPAIGN CONTEXT:
${sourceIcpContext}
Use this context to prioritize pains, fitScore, and messaging that match the target industry/role/angle.
Use WEBSITE_EXCERPT and NOTES (if available) to infer pains and fit; NOTES should influence fitScore, primaryPain, and summary when present.
For each prospect, output:
- prospectId: the provided PROSPECT_ID
- fitScore: integer 0-100
- fitLabel: one of hot, warm, cool, cold
- primaryPain: short description of the likely main pain (no meta-comments about missing data)
- summary: 2–3 sentence summary tailored to the company; uncertainty should be implicit ("may", "likely") without apologizing for missing info
Use any WEBSITE_EXCERPT if available to ground your assessment.
`;

    const userPrompt = `
Here are prospects to enrich:

${prospectBlocks}

Return a JSON array of objects in the same order with keys: prospectId, fitScore, fitLabel, primaryPain, summary.
`;

    let aiPreviews = null;

    try {
      const response = await openai.responses.create({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const output =
        response.output?.[0]?.content?.[0]?.text ||
        response.output?.[0]?.content?.[0]?.string ||
        '';

      if (output) {
        try {
          const parsed = JSON.parse(output);
          if (Array.isArray(parsed)) {
            aiPreviews = parsed;
          }
        } catch (err) {
          console.warn('Failed to parse AI enrichment JSON, falling back to heuristic.', err);
        }
      }
    } catch (err) {
      console.error('Error calling OpenAI for enrichment preview', err);
    }

    const previews =
      aiPreviews && Array.isArray(aiPreviews)
        ? prospects.map((p) => {
            const ai = aiPreviews.find((item) => item && item.prospectId === p.id);
            const fallback = buildHeuristicPreview(p);
            if (!ai) return fallback;

            const fitScore =
              typeof ai.fitScore === 'number' ? Math.min(Math.max(ai.fitScore, 0), 100) : fallback.fitScore;
            const fitLabel = ai.fitLabel || fallback.fitLabel;
            const primaryPain = ai.primaryPain || fallback.primaryPain;
            const summary = ai.summary || fallback.summary;

            return {
              prospectId: p.id,
              companyName: p.companyName || null,
              contactName: p.contactName || null,
              email: p.email || null,
              website: p.website || null,
              status: p.status || null,
              fitScore,
              fitLabel,
              primaryPain,
              summary,
            };
          })
        : prospects.map((p) => buildHeuristicPreview(p));

    return res.json(previews);
  } catch (err) {
    console.error('Error in POST /ai/sources/:sourceId/enrich-preview', err);
    return res.status(500).json({ error: 'Failed to fetch prospects for enrichment' });
  }
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
  const { status, sourceId, ownerName, search, archived, suppressed } = req.query;

  const whereClauses = [];
  const params = [];

  const includeSuppressed = suppressed === '1';
  const includeArchived = archived === '1';

  whereClauses.push(includeArchived ? 'archivedAt IS NOT NULL' : 'archivedAt IS NULL');
  if (includeSuppressed) {
    whereClauses.push('suppressedAt IS NOT NULL');
  } else {
    whereClauses.push('suppressedAt IS NULL');
  }

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
        lastContactedAt,
        archivedAt
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
    origin,
  } = req.body || {};

  const id = generateId('pros');
  const tagsValue = Array.isArray(tags) ? tags.join(',') : tags || null;
  const statusValue = status || 'uncontacted';
  const normalizedEmail = normalizeEmail(email);
  const normalizedDomain = extractDomainFromWebsiteOrEmail(website, email);
  const normalizedContactName = normalizeName(contactName);
  const originValue =
    origin && typeof origin === 'string' && origin.trim() ? origin.trim() : 'manual';

  checkDuplicateProspect({ normalizedEmail, normalizedDomain, normalizedContactName })
    .then((existing) => {
      if (existing) {
        return res.status(409).json({ error: 'DUPLICATE', existingId: existing.id });
      }

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
            ownerName,
            archivedAt,
            normalizedEmail,
            normalizedDomain,
            normalizedContactName,
            origin,
            suppressedAt,
            createdAt,
            updatedAt,
            lastContactedAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, datetime('now'), NULL, NULL)
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
          normalizedEmail,
          normalizedDomain,
          normalizedContactName,
          originValue,
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
                lastContactedAt,
                archivedAt,
                normalizedEmail,
                normalizedDomain,
                normalizedContactName,
                origin,
                suppressedAt
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
    })
    .catch((err) => {
      console.error('Error checking duplicate prospect:', err);
      return res.status(500).json({ error: 'Failed to create prospect' });
    });
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

app.patch('/prospects/:id/archive', async (req, res) => {
  try {
    const { id } = req.params;
    db.run(
      `UPDATE prospects SET archivedAt = datetime('now') WHERE id = ?`,
      [id],
      function archiveCallback(err) {
        if (err) {
          console.error('Error archiving prospect:', err);
          return res.status(500).json({ error: 'Failed to archive prospect' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Prospect not found' });
        }
        getProspectById(id)
          .then((row) => res.json(row))
          .catch((e) => {
            console.error('Error fetching archived prospect:', e);
            res.status(500).json({ error: 'Failed to archive prospect' });
          });
      },
    );
  } catch (err) {
    console.error('Error in PATCH /prospects/:id/archive', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/prospects/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    db.run(
      `UPDATE prospects SET archivedAt = NULL WHERE id = ?`,
      [id],
      function restoreCallback(err) {
        if (err) {
          console.error('Error restoring prospect:', err);
          return res.status(500).json({ error: 'Failed to restore prospect' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Prospect not found' });
        }
        getProspectById(id)
          .then((row) => res.json(row))
          .catch((e) => {
            console.error('Error fetching restored prospect:', e);
            res.status(500).json({ error: 'Failed to restore prospect' });
          });
      },
    );
  } catch (err) {
    console.error('Error in PATCH /prospects/:id/restore', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/prospects/:id/suppress', (req, res) => {
  const { id } = req.params;
  db.run(
    `UPDATE prospects SET suppressedAt = datetime('now') WHERE id = ?`,
    [id],
    function suppressCallback(err) {
      if (err) {
        console.error('Error suppressing prospect:', err);
        return res.status(500).json({ error: 'Failed to suppress prospect' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Prospect not found' });
      }
      getProspectById(id)
        .then((row) => res.json(row))
        .catch((e) => {
          console.error('Error fetching suppressed prospect:', e);
          res.status(500).json({ error: 'Failed to suppress prospect' });
        });
    },
  );
});

app.patch('/prospects/:id/unsuppress', (req, res) => {
  const { id } = req.params;
  db.run(
    `UPDATE prospects SET suppressedAt = NULL WHERE id = ?`,
    [id],
    function unsuppressCallback(err) {
      if (err) {
        console.error('Error unsuppressing prospect:', err);
        return res.status(500).json({ error: 'Failed to unsuppress prospect' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Prospect not found' });
      }
      getProspectById(id)
        .then((row) => res.json(row))
        .catch((e) => {
          console.error('Error fetching unsuppressed prospect:', e);
          res.status(500).json({ error: 'Failed to unsuppress prospect' });
        });
    },
  );
});

app.delete('/prospects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const prospect = await getProspectById(id);
    if (!prospect) {
      return res.status(404).json({ error: 'Prospect not found' });
    }
    if (!prospect.archivedAt) {
      return res.status(400).json({ error: 'Prospect must be archived before deletion' });
    }
    db.run(
      `DELETE FROM prospects WHERE id = ?`,
      [id],
      function deleteCallback(err) {
        if (err) {
          console.error('Error deleting prospect:', err);
          return res.status(500).json({ error: 'Failed to delete prospect' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Prospect not found' });
        }
        return res.json({ success: true, deletedId: id });
      },
    );
  } catch (err) {
    console.error('Error in DELETE /prospects/:id', err);
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

    const source = prospect.sourceId ? await getSourceById(prospect.sourceId) : null;
    const sourceName = (source && source.name) || prospect.sourceId || 'lead-gen';

    const body = {
      name: prospect.contactName || prospect.companyName || 'Lead from Lead Gen',
      company: prospect.companyName || prospect.contactName || 'Lead Gen Prospect',
      email: prospect.email || null,
      phone: prospect.phone || null,
      value: null,
      source: sourceName,
      createdAt: prospect.createdAt || new Date().toISOString(),
      address: null,
      ownerName:
        prospect.ownerName && typeof prospect.ownerName === 'string' && prospect.ownerName.trim()
          ? prospect.ownerName.trim()
          : 'Zax Kalyan',
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

  const existingLookup = new Map();
  const suppressedLookup = new Set();

  db.all(
    'SELECT id, normalizedEmail, normalizedDomain, normalizedContactName, suppressedAt FROM prospects',
    [],
    (lookupErr, rows) => {
      if (lookupErr) {
        console.error('Failed to load existing prospects for dedupe', lookupErr);
        return res.status(500).json({ error: 'Failed to bulk import prospects' });
      }

      for (const row of rows || []) {
        if (row.normalizedEmail) {
          existingLookup.set(`email:${row.normalizedEmail}`, row.id);
          if (row.suppressedAt) suppressedLookup.add(`email:${row.normalizedEmail}`);
        }
        if (row.normalizedDomain && row.normalizedContactName) {
          const key = `dn:${row.normalizedDomain}:${row.normalizedContactName}`;
          existingLookup.set(key, row.id);
          if (row.suppressedAt) suppressedLookup.add(key);
        }
      }

      const seen = new Set();

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
          origin,
        } = raw;

        const hasIdentifier =
          (companyName && String(companyName).trim() !== '') ||
          (contactName && String(contactName).trim() !== '') ||
          (email && String(email).trim() !== '');

        if (!hasIdentifier) {
          continue;
        }

        const normalizedEmail = normalizeEmail(email);
        const normalizedDomain = extractDomainFromWebsiteOrEmail(website, email);
        const normalizedContactName = normalizeName(contactName);

        const keyEmail = normalizedEmail ? `email:${normalizedEmail}` : null;
        const keyDomain =
          normalizedDomain && normalizedContactName
            ? `dn:${normalizedDomain}:${normalizedContactName}`
            : null;

        const duplicateKey =
          (keyEmail && existingLookup.has(keyEmail)) ||
          (keyDomain && existingLookup.has(keyDomain)) ||
          (keyEmail && seen.has(keyEmail)) ||
          (keyDomain && seen.has(keyDomain));
        const suppressedHit =
          (keyEmail && suppressedLookup.has(keyEmail)) ||
          (keyDomain && suppressedLookup.has(keyDomain));

        if (duplicateKey || suppressedHit) {
          continue;
        }

        if (keyEmail) seen.add(keyEmail);
        if (keyDomain) seen.add(keyDomain);

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

        const originValue =
          origin && typeof origin === 'string' && origin.trim() ? origin.trim() : 'purchased';

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
          normalizedEmail,
          normalizedDomain,
          normalizedContactName,
          origin: originValue,
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
          ownerName,
          normalizedEmail,
          normalizedDomain,
          normalizedContactName,
          origin,
          suppressedAt,
          createdAt,
          updatedAt,
          lastContactedAt,
          archivedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), NULL, NULL, NULL)
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
              p.normalizedEmail,
              p.normalizedDomain,
              p.normalizedContactName,
              p.origin,
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
    },
  );
});

app.listen(PORT, () => {
  console.log(`Lead Generation backend listening on port ${PORT}`);
});
