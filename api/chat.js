/**
 * Vercel Serverless Function — real AI replies (optional).
 *
 * LLM providers (set one API key):
 * - Groq (recommended if OpenAI quota is an issue): GROQ_API_KEY
 *   https://console.groq.com/keys — optional GROQ_MODEL (default: llama-3.1-8b-instant)
 * - OpenAI: OPENAI_API_KEY — optional OPENAI_MODEL (default: gpt-4o-mini)
 *
 * CHAT_LLM_PROVIDER: groq | openai — if unset, uses Groq when GROQ_API_KEY is set, else OpenAI.
 *
 * In index.html: <script src="js/chat.js" data-api-url="/api/chat"></script>
 *
 * Optional grounding: CHAT_SOURCES = comma-separated URLs (Google Maps, Facebook, etc.).
 */

// Very small in-memory cache (per serverless instance)
var _cache = {
  at: 0,
  text: '',
  sources: '',
};

function stripHtmlToText(html) {
  if (!html) return '';
  var s = String(html);
  // Remove scripts/styles/noscript blocks
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  // Keep some structure for readability
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n');
  // Drop remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode a few common entities (enough for our use)
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  // Normalize whitespace
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

function truncate(s, maxChars) {
  s = String(s || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n[truncated]';
}

async function fetchPublicPageText(url) {
  var controller = new AbortController();
  var timeout = setTimeout(function () {
    controller.abort();
  }, 6000);

  try {
    var r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some sites block default fetch UA; this helps a bit (still may be blocked, that's fine)
        'User-Agent':
          'Mozilla/5.0 (compatible; KlippersChatBot/1.0; +https://klippersbarbershop.com/)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!r.ok) return { url: url, ok: false, status: r.status, text: '' };

    // Limit total bytes read to avoid huge pages (Google can be massive)
    var raw = await r.text();
    raw = truncate(raw, 200000);
    var text = stripHtmlToText(raw);
    // Keep the excerpt modest so the model stays focused
    text = truncate(text, 12000);
    return { url: url, ok: true, status: r.status, text: text };
  } catch (e) {
    return { url: url, ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timeout);
  }
}

async function getGroundingText(sources) {
  var sourcesKey = sources.join(',');
  var now = Date.now();
  // Cache for 10 minutes per instance
  if (_cache.text && _cache.sources === sourcesKey && now - _cache.at < 10 * 60 * 1000) {
    return _cache.text;
  }

  var results = await Promise.all(
    sources.map(function (u) {
      return fetchPublicPageText(u);
    })
  );

  var usable = results.filter(function (x) {
    return x && x.ok && x.text;
  });

  var combined = usable
    .map(function (x) {
      return 'SOURCE: ' + x.url + '\n' + x.text;
    })
    .join('\n\n---\n\n');

  // Keep overall grounding bounded
  combined = truncate(combined, 18000);

  _cache.at = now;
  _cache.sources = sourcesKey;
  _cache.text = combined;

  return combined;
}

/**
 * Pick Groq or OpenAI. Groq uses OpenAI-compatible /v1/chat/completions.
 */
function getLlmConfig() {
  var force = String(process.env.CHAT_LLM_PROVIDER || '').trim().toLowerCase();
  var groqKey = process.env.GROQ_API_KEY;
  var openaiKey = process.env.OPENAI_API_KEY;

  if (force === 'groq') {
    if (!groqKey) return null;
    return {
      provider: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: groqKey,
      model: String(process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim(),
    };
  }
  if (force === 'openai') {
    if (!openaiKey) return null;
    return {
      provider: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      key: openaiKey,
      model: String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
    };
  }
  if (groqKey) {
    return {
      provider: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: groqKey,
      model: String(process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim(),
    };
  }
  if (openaiKey) {
    return {
      provider: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      key: openaiKey,
      model: String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
    };
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var llm = getLlmConfig();
  if (!llm) {
    return res.status(503).json({
      error: 'No LLM configured — set GROQ_API_KEY and/or OPENAI_API_KEY in Vercel Environment Variables',
    });
  }

  var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  var messages = body.messages;
  var context = body.context || '';

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Default sources match the JSON-LD links in index.html. Override with CHAT_SOURCES if you prefer.
  var defaultSources = [
    'https://www.facebook.com/klippersbarbershopvaudreuil/',
    'https://www.google.com/maps/place/100+Bd+Harwood,+Vaudreuil-Dorion,+QC+J7V+1X9',
  ];

  var sources = defaultSources;
  if (process.env.CHAT_SOURCES && String(process.env.CHAT_SOURCES).trim()) {
    sources = String(process.env.CHAT_SOURCES)
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  var grounding = '';
  try {
    grounding = await getGroundingText(sources);
  } catch (e) {
    grounding = '';
  }

  var system =
    'You are a friendly, concise assistant for Klippers Barber Shop (bilingual EN/FR when the user writes in French). ' +
    'Answer using the provided shop facts and the grounded source excerpts. ' +
    'If a detail is not present in those sources, say you are not sure and suggest calling 514-777-6239. ' +
    'Do not invent hours, prices, policies, or services. ' +
    'Keep answers short (2–5 sentences) unless the user asks for detail.\n\n' +
    'Shop facts (authoritative):\n' +
    context +
    '\n\nGrounded sources (may be partial if a site blocks scraping):\n' +
    (grounding || '[No source text available]');

  var openaiMessages = [{ role: 'system', content: system }].concat(
    messages.map(function (m) {
      var role = m.role === 'user' ? 'user' : 'assistant';
      return { role: role, content: String(m.content || '') };
    })
  );

  try {
    var r = await fetch(llm.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + llm.key,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: openaiMessages,
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    var data = await r.json();
    if (!r.ok) {
      console.error(llm.provider + ' LLM error', data);
      return res.status(502).json({ error: 'AI service error' });
    }

    var reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!reply) {
      return res.status(502).json({ error: 'Empty AI response' });
    }

    return res.status(200).json({ reply: reply.trim() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
