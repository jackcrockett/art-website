const { createHash } = require('crypto');

const IRACING_BASE = 'https://members-ng.iracing.com';

const DRIVERS = [
  { name: 'Luke Fallon',      custId: 1051347 },
  { name: 'Ryan Furber',      custId: 1299152 },
  { name: 'Noah Osbaldeston', custId: 987717  },
];

function hashPassword(email, password) {
  return createHash('sha256')
    .update(password + email.toLowerCase())
    .digest('base64');
}

function getLicenseLetter(level) {
  if (level == null) return '?';
  if (level >= 21) return 'Pro';
  if (level >= 17) return 'A';
  if (level >= 13) return 'B';
  if (level >= 9)  return 'C';
  if (level >= 5)  return 'D';
  return 'R';
}

async function fetchSigned(url, cookie) {
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`iRacing request failed: ${res.status} ${url}`);
  const json = await res.json();
  // iRacing API returns { link: "s3_url" } — follow it to get the actual data
  if (json.link) {
    const s3 = await fetch(json.link);
    return s3.json();
  }
  return json;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email    = process.env.IRACING_EMAIL;
  const password = process.env.IRACING_PASSWORD;

  if (!email || !password) {
    return res.status(500).json({ error: 'iRacing credentials not configured' });
  }

  try {
    // Authenticate
    const authRes = await fetch(`${IRACING_BASE}/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ email, password: hashPassword(email, password) }),
    });

    if (!authRes.ok) {
      const errBody = await authRes.text().catch(() => '');
      console.error(`iRacing auth failed: HTTP ${authRes.status} — ${errBody}`);
      return res.status(502).json({
        error: 'iRacing authentication failed',
        iracing_status: authRes.status,
      });
    }

    // Extract session cookies — getSetCookie() available Node 18.14+
    const rawCookies = typeof authRes.headers.getSetCookie === 'function'
      ? authRes.headers.getSetCookie()
      : [authRes.headers.get('set-cookie')].filter(Boolean);
    const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

    // Fetch career stats for each driver (includes current iRating + SR per category)
    const stats = await Promise.all(
      DRIVERS.map(async ({ name, custId }) => {
        try {
          const data = await fetchSigned(
            `${IRACING_BASE}/data/stats/member_career?cust_id=${custId}`,
            cookie
          );

          const categories = data.stats ?? [];

          // Prefer sports_car; fall back to road (covers prototypes and formula)
          const license =
            categories.find(c => c.category === 'sports_car') ??
            categories.find(c => c.category === 'road');

          const level = license?.license_level ?? null;

          return {
            custId,
            name,
            irating:      license?.irating       ?? null,
            safetyRating: license?.safety_rating  ?? null,
            licenseClass: getLicenseLetter(level),
          };
        } catch (err) {
          console.error(`Stats fetch failed for ${name}:`, err.message);
          return { custId, name, irating: null, safetyRating: null, licenseClass: null };
        }
      })
    );

    // Cache at CDN for 1 hour; serve stale while revalidating for up to 24 h
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ stats });

  } catch (err) {
    console.error('iRacing handler error:', err);
    return res.status(500).json({ error: 'Failed to fetch iRacing stats' });
  }
};
