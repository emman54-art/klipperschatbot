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
 * Groq free/on-demand tiers have strict TPM — keep payloads small. Override sizes if needed:
 * - CHAT_GROUNDING_MAX_PER_SOURCE (chars per URL excerpt, default 1200 for Groq, 6000 otherwise)
 * - CHAT_GROUNDING_MAX_TOTAL (chars for all sources combined, default 2800 for Groq, 12000 otherwise)
 * - CHAT_HISTORY_MAX_TURNS (default 6), CHAT_MESSAGE_MAX_CHARS (default 1200 per turn)
 *
 * Groq free tier TPM is tight: external page grounding is OFF by default for provider=groq.
 * Set CHAT_GROUNDING=1 (or true) on Vercel to enable Google/Facebook fetch for Groq.
 * OpenAI: grounding stays on unless CHAT_GROUNDING=0.
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

async function fetchPublicPageText(url, maxTextChars) {
  maxTextChars = maxTextChars || 12000;
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
    raw = truncate(raw, 120000);
    var text = stripHtmlToText(raw);
    text = truncate(text, maxTextChars);
    return { url: url, ok: true, status: r.status, text: text };
  } catch (e) {
    return { url: url, ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timeout);
  }
}

function groundingLimits(provider) {
  var envTotal = parseInt(String(process.env.CHAT_GROUNDING_MAX_TOTAL || '').trim(), 10);
  var envPer = parseInt(String(process.env.CHAT_GROUNDING_MAX_PER_SOURCE || '').trim(), 10);
  var def =
    provider === 'groq'
      ? { perSource: 1200, total: 2800 }
      : { perSource: 6000, total: 12000 };
  return {
    perSource: !isNaN(envPer) && envPer > 0 ? envPer : def.perSource,
    total: !isNaN(envTotal) && envTotal > 0 ? envTotal : def.total,
  };
}

function trimMessagesForLlm(messages, provider) {
  var maxTurns = parseInt(String(process.env.CHAT_HISTORY_MAX_TURNS || '').trim(), 10);
  var maxChars = parseInt(String(process.env.CHAT_MESSAGE_MAX_CHARS || '').trim(), 10);
  if (isNaN(maxTurns) || maxTurns < 1) maxTurns = provider === 'groq' ? 6 : 10;
  if (isNaN(maxChars) || maxChars < 100) maxChars = provider === 'groq' ? 1200 : 4000;

  var slice = messages.slice(-maxTurns);
  return slice.map(function (m) {
    var c = String(m.content || '');
    if (c.length > maxChars) c = c.slice(0, maxChars) + '…';
    var role = m.role === 'user' ? 'user' : 'assistant';
    return { role: role, content: c };
  });
}

async function getGroundingText(sources, limits) {
  limits = limits || { perSource: 1200, total: 2800 };
  var sourcesKey = sources.join(',') + '|' + limits.perSource + '|' + limits.total;
  var now = Date.now();
  // Cache for 10 minutes per instance
  if (_cache.text && _cache.sources === sourcesKey && now - _cache.at < 10 * 60 * 1000) {
    return _cache.text;
  }

  var results = await Promise.all(
    sources.map(function (u) {
      return fetchPublicPageText(u, limits.perSource);
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

  combined = truncate(combined, limits.total);

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
  if (llm.provider === 'groq' && context.length > 2500) {
    context = context.slice(0, 2500) + '…';
  }

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

  var gLimits = groundingLimits(llm.provider);
  var grounding = '';
  var gFlag = String(process.env.CHAT_GROUNDING || '').trim().toLowerCase();
  var fetchGrounding = true;
  if (llm.provider === 'groq') {
    fetchGrounding = gFlag === '1' || gFlag === 'true' || gFlag === 'yes';
  } else {
    fetchGrounding = gFlag !== '0' && gFlag !== 'false' && gFlag !== 'no';
  }
  if (fetchGrounding) {
    try {
      grounding = await getGroundingText(sources, gLimits);
    } catch (e) {
      grounding = '';
    }
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

  var openaiMessages = [{ role: 'system', content: system }].concat(trimMessagesForLlm(messages, llm.provider));

  var maxOut = llm.provider === 'groq' ? 320 : 500;
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
        max_tokens: maxOut,
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
