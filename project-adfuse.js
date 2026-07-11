const HOME_DOMAIN = "q1.superlokal.site";
const SHORTLINK_DOMAIN = "q2.superlokal.site";
const DOWNLOAD_DOMAIN = "q3.superlokal.site";
const TURNSTILE_SITE_KEY = "0x4AAAAAADxyv3h2mUq0sND2";

const PLATFORMS = {
  selfhosted: {
    label: "Self-hosted",
    baseUrl: null,
    referer: null,
    domain: SHORTLINK_DOMAIN,
  },
  download: {
    label: "Download",
    baseUrl: null,
    referer: null,
    domain: DOWNLOAD_DOMAIN,
  },
};
const DEFAULT_PLATFORM = "selfhosted";

function resolvePlatform(key) {
  return PLATFORMS[key] ? key : DEFAULT_PLATFORM;
}

function isSelfHosted(key) {
  return resolvePlatform(key) === "selfhosted";
}

function isDownload(key) {
  return resolvePlatform(key) === "download";
}

function buildTargetUrl(plat, id) {
  return id;
}

function getRefererFor(plat, id) {
  if (isSelfHosted(plat)) return originReferer(id);
  if (isDownload(plat)) return originReferer(id);
  return PLATFORMS[plat].referer;
}

function originReferer(fullUrl) {
  try {
    return new URL(fullUrl).origin + "/";
  } catch (e) {
    return undefined;
  }
}

const CODE_LENGTH = 7;
const CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const CACHE_MAX_AGE = 31536000;
const RESOLVE_CACHE_AGE = 3600; // 1 jam untuk /api/resolve

const OG_IMAGE_URL = "https://q1.superlokal.site/og-image.png";

function randomCode(len = CODE_LENGTH) {
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return out;
}

async function generateUniqueCode(kv) {
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const existing = await kv.get(code);
    if (!existing) return code;
  }
  throw new Error("Failed to generate a unique code, please try again.");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": `https://${HOME_DOMAIN}`,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.replace(/^www\./, "");

    // =========================================================
    // DOMAIN: q1.superlokal.site — landing page + generator
    // =========================================================
    if (host === HOME_DOMAIN) {
      if (url.pathname === "/") {
        return new Response(homePageHtml(), {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }
      if (url.pathname === "/robots.txt") {
        return new Response(
          `User-agent: *\nAllow: /\nSitemap: https://${HOME_DOMAIN}/sitemap.xml\n`,
          { headers: { "content-type": "text/plain; charset=UTF-8" } }
        );
      }
      if (url.pathname === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${HOME_DOMAIN}/</loc></url></urlset>`,
          { headers: { "content-type": "application/xml; charset=UTF-8" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }

    // =========================================================
    // DOMAIN: q2.superlokal.site — shortlink, player (Self-hosted)
    // =========================================================
    if (host === SHORTLINK_DOMAIN) {
      const cache = caches.default;

      // ---- CORS preflight ----
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": `https://${HOME_DOMAIN}`,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }
// ==========================
  // Block direct browser access
  // ==========================
  const mode = request.headers.get("Sec-Fetch-Mode");

if (
  url.pathname.startsWith("/api/") &&
  mode === "navigate"
) {
  return new Response("Forbidden", { status: 403 });
}
      if (url.pathname === "/api/generate" && request.method === "POST") {
        try {
          if (!env.LINKS) {
            return jsonResponse(
              { error: "KV namespace 'LINKS' is not bound to this worker." },
              500
            );
          }

          const body = await request.json().catch(() => ({}));
          const v = (body.v || "").trim();
          const ads = (body.ads || "").trim();
          const token = (body.token || "").trim();
          const platform = resolvePlatform((body.platform || "").trim());

          if (!v) {
            return jsonResponse({ error: "The video ID field is required." }, 400);
          }

          if (isSelfHosted(platform)) {
            try {
              const parsed = new URL(v);
              if (parsed.protocol !== "https:") throw new Error("not https");
            } catch (e) {
              return jsonResponse(
                { error: "Please enter a valid video link starting with https:// for self-hosted videos." },
                400
              );
            }
          }

          if (!env.TURNSTILE_SECRET_KEY) {
            return jsonResponse(
              { error: "TURNSTILE_SECRET_KEY is not set on this worker (wrangler secret)." },
              500
            );
          }

          if (!token) {
            return jsonResponse(
              { error: "Please complete the captcha verification first." },
              400
            );
          }

          const verifyBody = new URLSearchParams();
          verifyBody.append("secret", env.TURNSTILE_SECRET_KEY);
          verifyBody.append("response", token);
          const clientIp = request.headers.get("CF-Connecting-IP");
          if (clientIp) verifyBody.append("remoteip", clientIp);

          const verifyResp = await fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            { method: "POST", body: verifyBody }
          );
          const verifyData = await verifyResp.json().catch(() => ({ success: false }));

          if (!verifyData.success) {
            return jsonResponse(
              { error: "Captcha verification failed, please try again." },
              400
            );
          }

          const code = await generateUniqueCode(env.LINKS);
          await env.LINKS.put(
            code,
            JSON.stringify({
              v,
              ads,
              platform,
              createdAt: new Date().toISOString(),
            })
          );

          const plat = resolvePlatform(platform);
          const domain = PLATFORMS[plat].domain;
          const shortUrl = `https://${domain}/${code}.mp4`;
          return jsonResponse({ code, url: shortUrl });
        } catch (err) {
          return jsonResponse({ error: err.message }, 500);
        }
      }

      if (url.pathname === "/__purge-link" && request.method === "POST") {
        if (!env.ADMIN_SECRET) {
          return jsonResponse({ error: "ADMIN_SECRET is not set on this worker." }, 500);
        }
        const authHeader = request.headers.get("Authorization") || "";
        if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        if (!env.LINKS) {
          return jsonResponse({ error: "KV namespace 'LINKS' is not bound to this worker." }, 500);
        }

        const body = await request.json().catch(() => ({}));
        const code = (body.code || "").trim();
        if (!code) {
          return jsonResponse({ error: "Parameter 'code' is required ('yourcode' or 'all')." }, 400);
        }

        async function purgeOneCode(oneCode) {
          const purgedUrls = [];

          const shortlinkReq = new Request(`${url.origin}/${oneCode}.mp4`);
          await cache.delete(shortlinkReq);
          purgedUrls.push(shortlinkReq.url);

          const raw = await env.LINKS.get(oneCode);
          if (raw) {
            try {
              const { v, ads, platform } = JSON.parse(raw);
              if (v) {
                const plat = resolvePlatform(platform);
                const playerReq = new Request(
                  `${url.origin}/?v=${encodeURIComponent(v)}${
                    ads ? `&ads=${encodeURIComponent(ads)}` : ""
                  }&platform=${encodeURIComponent(plat)}`
                );
                await cache.delete(playerReq);
                purgedUrls.push(playerReq.url);
              }
            } catch (e) {
            }
          }
          return purgedUrls;
        }

        if (code.toLowerCase() === "all") {
          let totalCodes = 0;
          const purged = [];
          let cursor = undefined;

          do {
            const page = await env.LINKS.list({ cursor, limit: 1000 });
            for (const key of page.keys) {
              totalCodes++;
              const urls = await purgeOneCode(key.name);
              purged.push(...urls);
            }
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);

          return jsonResponse({ mode: "all", totalCodesPurged: totalCodes, purged });
        }

        const purged = await purgeOneCode(code);
        return jsonResponse({ mode: "single", code, purged });
      }

      if (url.pathname === "/__delete-links" && request.method === "POST") {
        if (!env.ADMIN_SECRET) {
          return jsonResponse({ error: "ADMIN_SECRET is not set on this worker." }, 500);
        }
        const authHeader = request.headers.get("Authorization") || "";
        if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        if (!env.LINKS) {
          return jsonResponse({ error: "KV namespace 'LINKS' is not bound to this worker." }, 500);
        }

        const body = await request.json().catch(() => ({}));
        const code = (body.code || "").trim();
        const codes = Array.isArray(body.codes)
          ? body.codes.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean)
          : null;
        const olderThanDays =
          typeof body.olderThanDays === "number" && body.olderThanDays >= 0
            ? body.olderThanDays
            : null;

        if (!code && (!codes || codes.length === 0) && olderThanDays === null) {
          return jsonResponse(
            {
              error:
                "Provide 'code' ('yourcode' or 'all'), 'codes' (an array of codes), or 'olderThanDays' (a number) in the request body.",
            },
            400
          );
        }

        async function deleteOneCode(oneCode) {
          const shortlinkReq = new Request(`${url.origin}/${oneCode}.mp4`);
          await cache.delete(shortlinkReq);

          const raw = await env.LINKS.get(oneCode);
          if (raw) {
            try {
              const { v, ads, platform } = JSON.parse(raw);
              if (v) {
                const plat = resolvePlatform(platform);
                const playerReq = new Request(
                  `${url.origin}/?v=${encodeURIComponent(v)}${
                    ads ? `&ads=${encodeURIComponent(ads)}` : ""
                  }&platform=${encodeURIComponent(plat)}`
                );
                await cache.delete(playerReq);
              }
            } catch (e) {

            }
          }

          await env.LINKS.delete(oneCode);
        }

        if (codes && codes.length > 0) {
          const results = [];
          for (const oneCode of codes) {
            const existed = (await env.LINKS.get(oneCode)) !== null;
            await deleteOneCode(oneCode);
            results.push({ code: oneCode, existed });
          }
          return jsonResponse({
            mode: "codes",
            totalRequested: codes.length,
            totalDeleted: results.filter((r) => r.existed).length,
            results,
          });
        }

        if (code) {
          if (code.toLowerCase() === "all") {
            let totalDeleted = 0;
            let cursor = undefined;

            do {
              const page = await env.LINKS.list({ cursor, limit: 1000 });
              for (const key of page.keys) {
                await deleteOneCode(key.name);
                totalDeleted++;
              }
              cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);

            return jsonResponse({ mode: "all", totalDeleted });
          }

          await deleteOneCode(code);
          return jsonResponse({ mode: "single", code, deleted: true });
        }

        const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
        let totalDeleted = 0;
        let totalSkipped = 0;
        const deletedCodes = [];
        let cursor = undefined;

        do {
          const page = await env.LINKS.list({ cursor, limit: 1000 });
          for (const key of page.keys) {
            const raw = await env.LINKS.get(key.name);
            let createdAtMs = null;
            if (raw) {
              try {
                const parsed = JSON.parse(raw);
                if (parsed.createdAt) createdAtMs = new Date(parsed.createdAt).getTime();
              } catch (e) {

              }
            }

            const isOld = createdAtMs === null || Number.isNaN(createdAtMs) || createdAtMs < cutoff;

            if (isOld) {
              await deleteOneCode(key.name);
              deletedCodes.push(key.name);
              totalDeleted++;
            } else {
              totalSkipped++;
            }
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);

        return jsonResponse({
          mode: "olderThanDays",
          olderThanDays,
          totalDeleted,
          totalSkipped,
          deletedCodes,
        });
      }

      // ---- Resolve endpoint: dengan cache 1 jam ----
      if (url.pathname === "/api/resolve" && request.method === "GET") {
        const code = url.searchParams.get("code") || "";
        
        if (!code || !env.LINKS) {
          return jsonResponse({ error: "Invalid request." }, 400);
        }

        const cache = caches.default;
        const cacheKey = new Request(`${url.origin}/api/resolve?code=${encodeURIComponent(code)}`);
        
        // Cek cache terlebih dahulu
        const cachedResp = await cache.match(cacheKey);
        if (cachedResp) {
          return cachedResp.clone();
        }

        const raw = await env.LINKS.get(code);
        if (!raw) {
          return jsonResponse({ error: "Not found." }, 404);
        }
        
        const { v, ads } = JSON.parse(raw);
        const response = new Response(JSON.stringify({ target: v, ads: ads || "" }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "Cache-Control": `public, max-age=${RESOLVE_CACHE_AGE}`,
          },
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      const shortMatch = url.pathname.match(/^\/([A-Za-z0-9]{7})\.mp4$/);
      if (shortMatch) {
        const cached = await cache.match(request);
        if (cached) return cached;

        const code = shortMatch[1];

        if (!env.LINKS) {
          return new Response("KV namespace 'LINKS' is not bound to this worker.", {
            status: 500,
          });
        }

        const raw = await env.LINKS.get(code);
        if (!raw) {
          return new Response("Link not found or has expired.", {
            status: 404,
          });
        }

        const { v, ads, platform } = JSON.parse(raw);
        const html = await renderPlayerPage(
          v,
          ads,
          resolvePlatform(platform),
          request.headers.get("User-Agent"),
          code
        );

        const response = new Response(html, {
          headers: {
            "content-type": "text/html; charset=UTF-8",
            "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
          },
        });

        ctx.waitUntil(cache.put(request, response.clone()));
        return response;
      }

      if (url.pathname === "/") {
        if (!url.searchParams.has("v")) {
          return Response.redirect(`https://${HOME_DOMAIN}/`, 301);
        }

        const cached = await cache.match(request);
        if (cached) return cached;

        const id = url.searchParams.get("v");
        const ads = url.searchParams.get("ads") || "";
        const platform = resolvePlatform(url.searchParams.get("platform") || "");
        const html = await renderPlayerPage(id, ads, platform, request.headers.get("User-Agent"), "");

        const response = new Response(html, {
          headers: {
            "content-type": "text/html; charset=UTF-8",
            "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
          },
        });

        ctx.waitUntil(cache.put(request, response.clone()));
        return response;
      }

      return new Response("Not found", { status: 404 });
    }

    // =========================================================
    // DOMAIN: q3.superlokal.site — download platform
    // =========================================================
    if (host === DOWNLOAD_DOMAIN) {
      const cache = caches.default;

      // ---- CORS preflight ----
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": `https://${HOME_DOMAIN}`,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin"
          },
        });
      }
// ==========================
  // Block direct browser access
  // ==========================
  const mode = request.headers.get("Sec-Fetch-Mode");

if (
  url.pathname.startsWith("/api/") &&
  mode === "navigate"
) {
  return new Response("Forbidden", { status: 403 });
}
      // ---- Resolve endpoint untuk download dengan cache ----
      if (url.pathname === "/api/resolve" && request.method === "GET") {
        const code = url.searchParams.get("code") || "";
        
        if (!code || !env.LINKS) {
          return jsonResponse({ error: "Invalid request." }, 400);
        }

        const cacheKey = new Request(`${url.origin}/api/resolve?code=${encodeURIComponent(code)}`);
        
        // Cek cache
        const cachedResp = await cache.match(cacheKey);
        if (cachedResp) {
          return cachedResp.clone();
        }

        const raw = await env.LINKS.get(code);
        if (!raw) {
          return jsonResponse({ error: "Not found." }, 404);
        }
        
        const { v, ads } = JSON.parse(raw);
        const response = new Response(JSON.stringify({ target: v, ads: ads || "" }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "Cache-Control": `public, max-age=${RESOLVE_CACHE_AGE}`,
          },
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      const shortMatch = url.pathname.match(/^\/([A-Za-z0-9]{7})\.mp4$/);
      if (shortMatch) {
        const cached = await cache.match(request);
        if (cached) return cached;

        const code = shortMatch[1];

        if (!env.LINKS) {
          return new Response("KV namespace 'LINKS' is not bound to this worker.", {
            status: 500,
          });
        }

        const raw = await env.LINKS.get(code);
        if (!raw) {
          return new Response("Link not found or has expired.", {
            status: 404,
          });
        }

        const { v, ads } = JSON.parse(raw);
        const html = renderDownloadPage(v, ads, code);

        const response = new Response(html, {
          headers: {
            "content-type": "text/html; charset=UTF-8",
            "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`,
          },
        });

        ctx.waitUntil(cache.put(request, response.clone()));
        return response;
      }

      return new Response("Not found", { status: 404 });
    }

    // Unrecognized domain
    return new Response("Domain not recognized by this worker.", { status: 404 });
  },
};

async function renderPlayerPage(id, ads, platform, userAgent, code) {
  const plat = resolvePlatform(platform);
  const config = PLATFORMS[plat];

  const targetUrl = buildTargetUrl(plat, id);
  const refererHeader = getRefererFor(plat, id);

  let pageTitle = "Player";
  try {
    const pageResp = await fetch(targetUrl, {
      headers: {
        ...(refererHeader ? { "Referer": refererHeader } : {}),
        "User-Agent": userAgent || "Mozilla/5.0",
      },
    });
    const pageHtml = await pageResp.text();

    const titlePatterns = [
      /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title>([^<]+)<\/title>/i,
    ];

    for (const re of titlePatterns) {
      const match = pageHtml.match(re);
      if (match && match[1]) {
        pageTitle = match[1].trim();
        break;
      }
    }
  } catch (err) {
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(pageTitle)}</title>
<style>
  html,body{
    margin:0;padding:0;height:100%;width:100%;
    background:#000;font-family:Arial,sans-serif;color:#fff;
    overflow:hidden;
  }
  #videoWrapper{
    position:relative;width:100vw;height:100vh;
    background:#000;
  }
  #videoFrame{
    width:100%;height:100%;border:0;display:block;
    filter:blur(6px);
    transition:filter .3s;
  }
  #videoFrame.unblurred{
    filter:none;
  }
  #ageGate{
    position:fixed;inset:0;z-index:999999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(75, 75, 75, 0.8);
  }
  #ageGateBox{
    background:#12151d;
    border:1px solid #1f2430;
    border-radius:14px;
    padding:32px 28px;
    max-width:340px;
    width:85%;
    text-align:center;
  }
  #ageGateBox p{
    margin:0 0 20px;
    font-size:15px;
    color:#c7cdda;
  }
  #ageGateButtons{
    display:flex;gap:12px;justify-content:center;
  }
  #ageGateButtons button{
    flex:1;padding:12px 10px;
    border:none;border-radius:10px;
    font-size:14px;font-weight:700;
    cursor:pointer;
  }
  #btnYes{background:#03a6ff;color:#00141f;}
  #btnNo{background:#241417;color:#ff8080;border:1px solid #3a1e22;}
</style>
</head>
<body>
  <div id="videoWrapper">
    <iframe id="videoFrame" allowfullscreen loading="lazy"></iframe>
    <div id="ageGate">
      <div id="ageGateBox">
        <p>Khusus 18+ ya! Pastikan umur kamu udah mencukupi buat masuk ke website ini.</p>
        <div id="ageGateButtons">
          <button id="btnYes" type="button">Ya, Saya 18+</button>
          <button id="btnNo" type="button">Tidak</button>
        </div>
      </div>
    </div>
  </div>
  <script>
  const resolveCode = ${JSON.stringify(code || "")};
const homeUrl = ${JSON.stringify(`https://${HOME_DOMAIN}/`)};

const btnYes = document.getElementById("btnYes");
const btnNo = document.getElementById("btnNo");
const ageGate = document.getElementById("ageGate");
const videoFrame = document.getElementById("videoFrame");

let confirmed = false;
let targetUrl = "";
let adUrl = "";

async function resolveTarget() {
  try {
    const resp = await fetch("/api/resolve?code=" + encodeURIComponent(resolveCode));
    const data = await resp.json();
    targetUrl = data.target || "";
    adUrl = data.ads || "";
    videoFrame.src = targetUrl;
  } catch (e) {
    videoFrame.src = "about:blank";
  }
}
resolveTarget();

btnYes.addEventListener("click", function () {
  if (!confirmed) {
    confirmed = true;
    if (adUrl) window.open(adUrl, "_blank");
    btnYes.textContent = "Lanjutkan";
    return;
  }
  ageGate.style.display = "none";
  videoFrame.classList.add("unblurred");
  if (targetUrl) location.href = targetUrl;
});

btnNo.addEventListener("click", function () {
  if (adUrl) window.open(adUrl, "_blank");
  location.href = homeUrl;
});
  </script>
</body>
</html>`;
}

function renderDownloadPage(downloadUrl, adUrl, code) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#090b10">
<title>Download File</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#090b10;
    --surface:#12151d;
    --surface-2:#0e1118;
    --border:#1f2430;
    --text:#eef1f7;
    --muted:#8791a8;
    --accent:#03a6ff;
    --accent-hover:#2bb6ff;
    --accent-soft:rgba(3,166,255,0.12);
    --radius:14px;
    --font-display:'Space Grotesk',system-ui,sans-serif;
    --font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  }
  *{box-sizing:border-box;}
  html,body{
    margin:0;padding:0;height:100%;width:100%;
    background:
      radial-gradient(1200px 600px at 85% -10%, rgba(3,166,255,0.10), transparent 60%),
      radial-gradient(900px 500px at -10% 20%, rgba(255,176,32,0.06), transparent 55%),
      var(--bg);
    font-family:var(--font-body);
    color:var(--text);
    display:flex;align-items:center;justify-content:center;
    line-height:1.5;
  }
  #downloadContainer{
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:40px 32px;
    max-width:420px;
    width:90%;
    box-shadow:0 10px 40px rgba(0,0,0,0.3);
    text-align:center;
  }
  .icon-wrapper{
    margin-bottom:24px;
  }
  .icon{
    width:80px;height:80px;
    margin:0 auto;
    background:var(--accent-soft);
    border:1px solid var(--border);
    border-radius:var(--radius);
    display:flex;align-items:center;justify-content:center;
    font-size:40px;
  }
  h1{
    font-family:var(--font-display);
    font-size:24px;
    margin:0 0 12px;
    font-weight:600;
    letter-spacing:-0.01em;
  }
  .description{
    font-size:14px;
    color:var(--muted);
    margin:0 0 28px;
  }
  #progressWrapper{
    margin:24px 0;display:none;
  }
  #progressWrapper.show{display:block;}
  .progress-label{
    font-size:12px;
    color:var(--muted);
    margin-bottom:8px;
    text-align:left;
    font-family:var(--font-display);
  }
  #progressBar{
    width:100%;height:8px;
    background:var(--surface-2);
    border-radius:10px;
    overflow:hidden;
    margin-bottom:8px;
    border:1px solid var(--border);
  }
  #progressFill{
    height:100%;width:0%;
    background:var(--accent);
    transition:width 0.3s ease;
    border-radius:9px;
  }
  #progressPercent{
    font-size:12px;
    color:var(--accent);
    font-weight:600;
    font-family:var(--font-display);
  }
  button{
    width:100%;
    padding:13px 14px;
    border:none;
    border-radius:10px;
    font-size:14px;
    font-weight:700;
    cursor:pointer;
    transition:all 0.15s;
    margin-top:12px;
    font-family:var(--font-body);
  }
  button:hover{transform:translateY(-2px);}
  button:active{transform:translateY(0);}
  button:disabled{opacity:.6;cursor:not-allowed;}
  #downloadBtn{
    background:var(--accent);
    color:#00141f;
  }
  #downloadBtn:hover{
    background:var(--accent-hover);
  }
  #downloadNowBtn{
    background:var(--accent);
    color:#00141f;
    display:none;
  }
  #downloadNowBtn.show{display:block;}
  #downloadNowBtn:hover{
    background:var(--accent-hover);
  }
  .info-text{
    font-size:12px;
    color:var(--muted);
    margin-top:16px;
  }
  @media (max-width:480px){
    #downloadContainer{
      padding:28px 20px;
    }
    h1{font-size:20px;}
    button{font-size:14px;padding:12px;}
  }
</style>
</head>
<body>
  <div id="downloadContainer">
    <div class="icon-wrapper">
      <div class="icon">⬇️</div>
    </div>
    <h1>Download File</h1>
    <p class="description">Click the button below to start downloading your file.</p>
    
    <div id="progressWrapper">
      <div class="progress-label">Downloading... <span id="progressPercent">0%</span></div>
      <div id="progressBar">
        <div id="progressFill"></div>
      </div>
    </div>
    
    <button id="downloadBtn" type="button">Download</button>
    <button id="downloadNowBtn" type="button">Download Now</button>
    
    <p class="info-text">File will start downloading automatically.</p>
  </div>

  <script>
  const resolveCode = ${JSON.stringify(code)};
  const homeUrl = ${JSON.stringify(`https://${HOME_DOMAIN}/`)};
  
  const downloadBtn = document.getElementById("downloadBtn");
  const downloadNowBtn = document.getElementById("downloadNowBtn");
  const progressWrapper = document.getElementById("progressWrapper");
  const progressFill = document.getElementById("progressFill");
  const progressPercent = document.getElementById("progressPercent");
  const downloadContainer = document.getElementById("downloadContainer");
  
  let targetUrl = "";
  let adUrl = "";
  let isDownloading = false;
  
  // Resolve target dan ad URL
  async function resolveTarget() {
    try {
      const resp = await fetch("/api/resolve?code=" + encodeURIComponent(resolveCode));
      const data = await resp.json();
      if (data.error) {
        throw new Error(data.error);
      }
      targetUrl = data.target || "";
      adUrl = data.ads || "";
    } catch (e) {
      console.error("Error resolving:", e);
      downloadContainer.innerHTML = '<div style="padding:40px;text-align:center;"><p style="color:#ff8080;font-size:16px;margin:0;">Terjadi kesalahan saat memuat file.</p></div>';
      downloadBtn.disabled = true;
    }
  }
  
  resolveTarget();
  
  downloadBtn.addEventListener("click", async function () {
    if (isDownloading) return;
    
    isDownloading = true;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Processing...";
    
    // Trigger ad link
    if (adUrl) {
      window.open(adUrl, "_blank");
    }
    
    // Show progress bar
    progressWrapper.classList.add("show");
    
    // Simulate progress untuk 15 detik
    const duration = 15000; // 15 detik
    const startTime = Date.now();
    
    const interval = setInterval(function () {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * 100, 100);
      
      progressFill.style.width = progress + "%";
      progressPercent.textContent = Math.round(progress) + "%";
      
      if (progress >= 100) {
        clearInterval(interval);
        downloadBtn.style.display = "none";
        downloadNowBtn.classList.add("show");
      }
    }, 100);
  });
  
  downloadNowBtn.addEventListener("click", function () {
    if (targetUrl) {
      location.href = targetUrl;
    }
  });
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function homePageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clickvid - Add Your Own Ads to Any Video Link</title>
<meta name="description" content="Bring a video from your own host and attach your own ad or affiliate link. Clickvid wraps both into a clean shortlink with an auto thumbnail and built-in player page. Free, no sign-up required.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://${HOME_DOMAIN}/">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#090b10">
<meta property="og:type" content="website">
<meta property="og:title" content="Clickvid - Add Your Own Ads to Any Video Link">
<meta property="og:description" content="Attach your own ad or affiliate link to any video you host. Get a shortlink with an auto thumbnail and built-in player in seconds no sign-up needed.">
<meta property="og:url" content="https://${HOME_DOMAIN}/">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Clickvid - Add Your Own Ads to Any Video Link">
<meta name="twitter:description" content="Attach your own ad or affiliate link to any video you host auto thumbnail, built-in player, no sign-up.">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "Clickvid",
  "url": "https://${HOME_DOMAIN}/",
  "applicationCategory": "UtilitiesApplication",
  "applicationSubCategory": "Video Link Shortener",
  "operatingSystem": "Web",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "A free tool to wrap your own hosted video with your own ad or affiliate link, generating a shortlink with an auto thumbnail and a built-in player page."
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is Clickvid free to use?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. There's no fee and no account required to generate a shortlink." }
    },
    {
      "@type": "Question",
      "name": "What is the ad or affiliate link field for?",
      "acceptedAnswer": { "@type": "Answer", "text": "It's optional and entirely up to you an affiliate link, an online store, or any ad destination you choose. Clickvid doesn't provide ads or generate income itself; it simply displays your chosen link once before redirecting to your video." }
    },
    {
      "@type": "Question",
      "name": "Do generated links expire?",
      "acceptedAnswer": { "@type": "Answer", "text": "As long as the data stays in storage, the link will remain active and accessible at any time." }
    }
  ]
}
</script>
<style>
  :root{
    --bg:#090b10;
    --surface:#12151d;
    --surface-2:#0e1118;
    --border:#1f2430;
    --text:#eef1f7;
    --muted:#8791a8;
    --accent:#03a6ff;
    --accent-hover:#2bb6ff;
    --accent-soft:rgba(3,166,255,0.12);
    --warm:#ffb020;
    --warm-soft:rgba(255,176,32,0.12);
    --radius:14px;
    --font-display:'Space Grotesk',system-ui,sans-serif;
    --font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    --font-mono:'JetBrains Mono',ui-monospace,Consolas,monospace;
  }
  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}
  html,body{overflow-x:hidden;}
  body{
    margin:0;
    background:
      radial-gradient(1200px 600px at 85% -10%, rgba(3,166,255,0.10), transparent 60%),
      radial-gradient(900px 500px at -10% 20%, rgba(255,176,32,0.06), transparent 55%),
      var(--bg);
    color:var(--text);
    font-family:var(--font-body);
    line-height:1.5;
  }
  a{color:inherit;}
  .wrap{
    max-width:1080px;
    margin:0 auto;
    padding:0 24px;
  }

  /* ---- Nav ---- */
  header{
    position:sticky;top:0;z-index:20;
    background:rgba(9,11,16,0.72);
    backdrop-filter:blur(10px);
    border-bottom:1px solid var(--border);
  }
  .nav{
    display:flex;align-items:center;justify-content:space-between;
    padding:16px 0;
  }
  .logo{
    font-family:var(--font-display);
    font-weight:700;
    font-size:18px;
    letter-spacing:-0.02em;
    display:flex;align-items:center;gap:8px;
    text-decoration:none;
    color:var(--text);
  }
  .logo .dot{
    width:8px;height:8px;border-radius:2px;
    background:var(--accent);
    box-shadow:0 0 12px var(--accent);
  }
  nav.links{
    display:flex;gap:28px;
    font-size:14px;
    color:var(--muted);
  }
  nav.links a{text-decoration:none;transition:color .15s;}
  nav.links a:hover{color:var(--text);}
  .nav-toggle{
    display:none;
    width:auto;
    align-items:center;justify-content:center;
    background:transparent;
    border:1px solid var(--border);
    color:var(--text);
    padding:8px;
    border-radius:8px;
  }
  .mobile-menu{
    display:none;
    flex-direction:column;
    background:var(--surface);
    border-top:1px solid var(--border);
  }
  .mobile-menu.open{display:flex;}
  .mobile-menu a{
    padding:14px 24px;
    color:var(--muted);
    text-decoration:none;
    font-size:14px;
    border-bottom:1px solid var(--border);
  }
  .mobile-menu a:last-child{border-bottom:none;}
  .mobile-menu a:active,.mobile-menu a:hover{color:var(--text);}
  @media (max-width:640px){
    nav.links{display:none;}
    .nav-toggle{display:inline-flex;}
  }

  /* ---- Hero ---- */
  .hero{
    padding:64px 0 56px;
    border-top:none;
  }
  .hero .wrap{
    display:grid;
    grid-template-columns:1.05fr 0.95fr;
    gap:48px;
    align-items:start;
  }
  @media (max-width:900px){
    .hero{padding:44px 0 32px;}
    .hero .wrap{grid-template-columns:1fr;}
  }
  .eyebrow{
    display:inline-flex;align-items:center;gap:8px;
    font-family:var(--font-mono);
    font-size:12px;
    color:var(--accent);
    background:var(--accent-soft);
    border:1px solid rgba(3,166,255,0.3);
    padding:6px 12px;
    border-radius:999px;
    margin-bottom:20px;
  }
  h1{
    font-family:var(--font-display);
    font-size:clamp(32px,4.4vw,48px);
    line-height:1.08;
    letter-spacing:-0.02em;
    margin:0 0 18px;
  }
  h1 .accent{color:var(--accent);}
  .hero p.lead{
    color:var(--muted);
    font-size:16px;
    max-width:46ch;
    margin:0 0 28px;
  }
  .hero-tagline{
    font-family:var(--font-mono);
    font-size:13px;
    color:var(--accent);
    letter-spacing:0.01em;
    margin:0;
  }

  /* ---- Generator card ---- */
  .card{
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:28px;
  }
  .card h2.card-title{
    font-family:var(--font-display);
    font-size:16px;
    margin:0 0 4px;
  }
  .card p.card-sub{
    color:var(--muted);
    font-size:13px;
    margin:0 0 20px;
  }
  label{
    display:block;
    font-size:12px;
    font-weight:600;
    letter-spacing:0.02em;
    margin:0 0 6px;
    color:var(--muted);
    font-family:var(--font-mono);
  }
  input{
    width:100%;
    padding:12px 14px;
    border-radius:10px;
    border:1px solid var(--border);
    background:var(--surface-2);
    color:var(--text);
    font-size:14px;
    font-family:var(--font-mono);
    margin-bottom:16px;
    outline:none;
    transition:border-color .15s, box-shadow .15s;
  }
  input:focus{
    border-color:var(--accent);
    box-shadow:0 0 0 3px var(--accent-soft);
  }
  input::placeholder{color:#4b5468;}
  select{
    width:100%;
    padding:12px 14px;
    border-radius:10px;
    border:1px solid var(--border);
    background:var(--surface-2);
    color:var(--text);
    font-size:14px;
    font-family:var(--font-mono);
    margin-bottom:16px;
    outline:none;
    transition:border-color .15s, box-shadow .15s;
    appearance:none;
    -webkit-appearance:none;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%238791a8' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
    background-repeat:no-repeat;
    background-position:right 14px center;
  }
  select:focus{
    border-color:var(--accent);
    box-shadow:0 0 0 3px var(--accent-soft);
  }
  button{
    width:100%;
    padding:13px 14px;
    border:none;
    border-radius:10px;
    background:var(--accent);
    color:#00141f;
    font-size:14px;
    font-weight:700;
    font-family:var(--font-body);
    cursor:pointer;
    transition:background .15s, transform .1s;
  }
  button:hover{background:var(--accent-hover);}
  button:active{transform:translateY(1px);}
  button:disabled{opacity:.6;cursor:not-allowed;}

  .turnstile-box{margin-top:14px;display:flex;justify-content:center;}

  #errorMsg{
    color:#ff8080;
    font-size:13px;
    margin-top:12px;
    display:none;
  }
  #result{margin-top:18px;display:none;}
  #result.show{display:block;}
  .result-box{
    display:flex;flex-wrap:wrap;gap:8px;
    background:var(--surface-2);
    border:1px solid var(--border);
    border-radius:10px;
    padding:10px 12px;
  }
  .result-box input{margin:0;border:none;background:transparent;padding:4px 0;flex:1 1 160px;min-width:0;width:auto;}
  .result-box button{width:auto;padding:8px 14px;font-size:13px;white-space:nowrap;flex:0 0 auto;}

  #bookmarks{margin-top:24px;}
  #bookmarks.hidden{display:none;}
  .bookmarks-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
  .bookmarks-header label{margin:0;}
  .bookmarks-count{font-size:11px;color:var(--muted);font-family:var(--font-mono);}
  .bookmarks-desc{margin:0 0 10px;font-size:12px;color:var(--muted);}
  .bookmark-list{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;}
  .bookmark-item{
    background:var(--surface-2);
    border:1px solid var(--border);
    border-radius:10px;
    padding:4px;
  }
  .bookmark-item span{
    display:block;
    width:100%;
    margin-bottom:8px;
    font-size:12px;font-family:var(--font-mono);color:var(--text);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .bookmark-actions{display:flex;gap:8px;}
  .bookmark-item button{width:auto;padding:6px 10px;font-size:12px;font-weight:600;}
  .bookmark-item .copy-btn{background:var(--accent);color:#00141f;}
  .bookmark-item .copy-btn:hover{background:var(--accent-hover);}
  .bookmark-item .del-btn{background:#241417;color:#ff8080;border:1px solid #3a1e22;}
  .bookmark-item .del-btn:hover{background:#3a1e22;}

  @media (max-width:900px){
    .card{padding:18px;}
  }
  @media (max-width:380px){
    .bookmark-actions{gap:6px;}
    .bookmark-item button{padding:6px 8px;font-size:11px;}
    .result-box{gap:6px;padding:8px 10px;}
    .card{padding:14px;}
    .wrap{padding:0 16px;}
  }

  /* ---- Sections ---- */
  section{padding:56px 0;border-top:1px solid var(--border);}
  .section-head{margin-bottom:36px;max-width:56ch;}
  .section-head .eyebrow{margin-bottom:14px;}
  h2.section-title{
    font-family:var(--font-display);
    font-size:clamp(24px,3vw,32px);
    letter-spacing:-0.01em;
    margin:0 0 10px;
  }
  .section-head p{color:var(--muted);margin:0;font-size:15px;}

  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
  @media (max-width:800px){ .steps{grid-template-columns:1fr;} }
  .step{
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:22px;
  }
  .step .num{
    font-family:var(--font-mono);
    font-size:12px;color:var(--accent);
    margin-bottom:12px;
  }
  .step h3{font-family:var(--font-display);font-size:17px;margin:0 0 8px;}
  .step p{color:var(--muted);font-size:14px;margin:0;}

  .features{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}
  @media (max-width:900px){ .features{grid-template-columns:repeat(2,1fr);} }
  @media (max-width:600px){ .features{grid-template-columns:1fr;} }
  .feature{
    background:var(--surface);
    border:1px solid var(--border);
    border-radius:var(--radius);
    padding:20px;
  }
  .feature .icon{
    width:34px;height:34px;
    border-radius:9px;
    background:var(--accent-soft);
    display:flex;align-items:center;justify-content:center;
    margin-bottom:14px;
  }
  .feature.warm .icon{background:var(--warm-soft);}
  .feature .icon svg{width:18px;height:18px;}
  .feature h3{font-family:var(--font-display);font-size:15px;margin:0 0 6px;}
  .feature p{color:var(--muted);font-size:13px;margin:0;}

  .faq{max-width:720px;}
  details{
    border-bottom:1px solid var(--border);
    padding:16px 0;
  }
  details summary{
    cursor:pointer;
    font-family:var(--font-display);
    font-size:15px;
    list-style:none;
    display:flex;align-items:center;justify-content:space-between;
  }
  details summary::-webkit-details-marker{display:none;}
  details summary::after{
    content:'+';
    color:var(--accent);
    font-size:18px;
    font-family:var(--font-mono);
  }
  details[open] summary::after{content:'−';}
  details p{color:var(--muted);font-size:14px;margin:10px 0 0;max-width:60ch;}

  footer{
    border-top:1px solid var(--border);
    padding:28px 0 40px;
    color:var(--muted);
    font-size:13px;
    display:flex;align-items:center;justify-content:space-between;
    flex-wrap:wrap;gap:12px;
  }
  footer .logo{font-size:14px;}

  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <div class="nav">
      <a class="logo" href="/"><span class="dot"></span>Clickvid</a>
      <nav class="links">
        <a href="#how-it-works">How it works</a>
        <a href="#features">Features</a>
        <a href="#faq">FAQ</a>
      </nav>
      <button class="nav-toggle" id="navToggle" type="button" aria-label="Open menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
      </button>
    </div>
  </div>
  <nav class="mobile-menu" id="mobileMenu">
    <a href="#how-it-works">How it works</a>
    <a href="#features">Features</a>
    <a href="#faq">FAQ</a>
  </nav>
</header>

<main>
  <section class="hero">
    <div class="wrap">
    <div>
      <h1>Add your own ads<br>to <span class="accent">any video link.</span></h1>
      <span class="eyebrow">Clickvid — Free Shortlink Generator</span>
      <p class="lead">Bring a video from your own server or CDN, your own server, or anywhere else and attach your own ad or affiliate link. Clickvid wraps both into a single shortlink, with a built-in player page. Viewers click through your link first you decide what they see before the video plays.</p>
      <p class="hero-tagline">No sign-up. No upload limit. Just paste and share.</p>
    </div>

    <div class="card" id="generator">
      <h2 class="card-title">Create your shortlink</h2>
      <p class="card-sub">Choose your platform and enter your Link video the ad link is optional.</p>

      <label for="platformInput">Video platform</label>
      <select id="platformInput">
        <option value="selfhosted">Self-hosted</option>
        <option value="download">Download</option>
      </select>

      <label for="vInput" id="vInputLabel">URL Video</label>
      <input id="vInput" type="text" placeholder="https://linkvideo.com/e/abcd1234" autocomplete="off">

      <label for="adsInput">Ad or affiliate link (optional)</label>
      <input id="adsInput" type="text" placeholder="https://your-affiliate-link.com" autocomplete="off">

      <button id="generateBtn" type="button">Generate shortlink</button>

      <div class="turnstile-box">
        <div id="turnstileWidget" class="cf-turnstile" data-sitekey="${TURNSTILE_SITE_KEY}" data-theme="dark" data-callback="turnstileCallback" data-expired-callback="turnstileExpiredCallback" data-error-callback="turnstileExpiredCallback"></div>
      </div>

      <p id="errorMsg"></p>

      <div id="result">
        <label>Your shortlink</label>
        <div class="result-box">
          <input id="resultInput" type="text" readonly>
          <button id="copyBtn" type="button">Copy</button>
        </div>
      </div>

        <div id="bookmarks" class="hidden">
          <div class="bookmarks-header">
            <label>Link history</label>
            <span class="bookmarks-count" id="bookmarksCount"></span>
          </div>
          <p class="bookmarks-desc">Automatically saved in this browser.</p>
          <div class="bookmark-list" id="bookmarkList"></div>
        </div>
      </div>
    </div>
  </section>

  <section id="how-it-works">
    <div class="wrap">
      <div class="section-head">
        <span class="eyebrow">process</span>
        <h2 class="section-title">Three steps, done.</h2>
        <p>No complicated dashboard the generator only does three things, in order.</p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="num">01</div>
          <h3>Paste your video ID</h3>
          <p>Enter the LINK or URL of the video you already host from any platform, including your own server.</p>
        </div>
        <div class="step">
          <div class="num">02</div>
          <h3>Add your ad or affiliate link (optional)</h3>
          <p>Drop in any destination link you want an affiliate offer, your store, or an ad. It's entirely your choice.</p>
        </div>
        <div class="step">
          <div class="num">03</div>
          <h3>Generate &amp; share</h3>
          <p>Get a unique shortlink with a built-in player page, ready to post.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="features">
    <div class="wrap">
      <div class="section-head">
        <span class="eyebrow">features</span>
        <h2 class="section-title">Built to be shared with your link attached.</h2>
        <p>Every link you create comes fully dressed, not just a bare redirect.</p>
      </div>
      <div class="features">
        <div class="feature warm">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#ffb020" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/></svg></div>
          <h3>Your Link, Your Choice</h3>
          <p>Attach any ad, affiliate offer, or online store link Clickvid just shows it before the video plays.</p>
        </div>
        <div class="feature">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#03a6ff" stroke-width="1.8"><path d="M12 3l8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z"/></svg></div>
          <h3>Bring Your Own Video</h3>
          <p>Works with any video host including your own domain just paste the ID or full URL, no uploads required.</p>
        </div>
        <div class="feature">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#03a6ff" stroke-width="1.8"><path d="M12 2l2.4 5.8L20 9l-4.5 3.9L16.8 19 12 15.8 7.2 19l1.3-6.1L4 9l5.6-1.2z"/></svg></div>
          <h3>Unique 7-Character Codes</h3>
          <p>A random combination that's practically impossible to guess.</p>
        </div>
        <div class="feature">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#03a6ff" stroke-width="1.8"><path d="M12 3l8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z"/></svg></div>
          <h3>No Sign-Up, Ever</h3>
          <p>Generate a shortlink and start sharing across social media immediately.</p>
        </div>
        <div class="feature">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#03a6ff" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg></div>
          <h3>Local Link History</h3>
          <p>Every link you've created is saved right in your browser, ready to reuse or resend.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="faq">
    <div class="wrap">
      <div class="section-head">
        <span class="eyebrow">faq</span>
        <h2 class="section-title">Frequently asked questions</h2>
      </div>
      <div class="faq">
        <details open>
          <summary>Is Clickvid free to use?</summary>
          <p>Yes. There's no fee and no account required to generate a shortlink.</p>
        </details>
        <details>
          <summary>What is the ad or affiliate link field for?</summary>
          <p>It's optional and entirely up to you an affiliate link, an online store, or any ad destination you choose. Clickvid doesn't provide ads or generate income itself; it simply displays your chosen link once before redirecting to your video.</p>
        </details>
        <details>
          <summary>Do generated links expire?</summary>
          <p>As long as the data stays in storage, the link will remain active and accessible at any time.</p>
        </details>
      </div>
    </div>
  </section>
</main>

<footer class="wrap">
  <div class="logo"><span class="dot"></span>Clickvid</div>
  <div>&copy; ${new Date().getFullYear()} Clickvid - Add Your Own Ads to Any Video Link</div>
</footer>

<script>
  const API_ORIGIN = "https://${SHORTLINK_DOMAIN}";
  const navToggle = document.getElementById("navToggle");
  const mobileMenu = document.getElementById("mobileMenu");
  if (navToggle && mobileMenu) {
    navToggle.addEventListener("click", function () {
      const isOpen = mobileMenu.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    mobileMenu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        mobileMenu.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  const platformInput = document.getElementById("platformInput");
  const vInputLabel = document.getElementById("vInputLabel");
  const vInput = document.getElementById("vInput");
  const adsInput = document.getElementById("adsInput");
  const generateBtn = document.getElementById("generateBtn");
  const resultBox = document.getElementById("result");
  const resultInput = document.getElementById("resultInput");
  const copyBtn = document.getElementById("copyBtn");
  const errorMsg = document.getElementById("errorMsg");

  const bookmarksBox = document.getElementById("bookmarks");
  const bookmarkList = document.getElementById("bookmarkList");
  const bookmarksCount = document.getElementById("bookmarksCount");

  const STORAGE_KEY = "clickvid_bookmarks";
  const MAX_BOOKMARKS = 100;

  function updateFormForPlatform() {
    const platform = platformInput.value;
    if (platform === "download") {
      vInputLabel.textContent = "Link Download";
      vInput.placeholder = "https://yourdomain.com/files/myfile.zip";
    } else {
      vInputLabel.textContent = "Link Video";
      vInput.placeholder = "https://yourdomain.com/embed/video-page";
    }
  }
  platformInput.addEventListener("change", updateFormForPlatform);
  updateFormForPlatform();

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveBookmarks(list) {
    const trimmed = list.slice(-MAX_BOOKMARKS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return trimmed;
  }

  function addBookmark(url) {
    let list = loadBookmarks();
    list.push(url);
    list = saveBookmarks(list);
    renderBookmarks(list);
  }

  function removeBookmark(index) {
    let list = loadBookmarks();
    list.splice(index, 1);
    list = saveBookmarks(list);
    renderBookmarks(list);
  }

  function renderBookmarks(list) {
    list = list || loadBookmarks();

    if (list.length === 0) {
      bookmarksBox.classList.add("hidden");
      bookmarkList.innerHTML = "";
      return;
    }

    bookmarksBox.classList.remove("hidden");
    bookmarksCount.textContent = list.length + " / " + MAX_BOOKMARKS;

    const rows = list
      .map(function (url, i) {
        return (
          '<div class="bookmark-item" data-index="' + i + '">' +
          '<span title="' + escapeAttr(url) + '">' + escapeHtmlClient(url) + "</span>" +
          '<div class="bookmark-actions">' +
          '<button type="button" class="copy-btn" data-action="copy">Copy</button>' +
          '<button type="button" class="del-btn" data-action="delete">Delete</button>' +
          "</div>" +
          "</div>"
        );
      })
      .reverse()
      .join("");

    bookmarkList.innerHTML = rows;
  }

  function escapeHtmlClient(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(str) {
    return escapeHtmlClient(str).replace(/"/g, "&quot;");
  }

  function isValidHttpsUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function isValidAdsUrl(value) {
    if (!value) return true;
    return isValidHttpsUrl(value);
  }

  bookmarkList.addEventListener("click", async function (e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const item = e.target.closest(".bookmark-item");
    const index = parseInt(item.getAttribute("data-index"), 10);
    const action = btn.getAttribute("data-action");
    const list = loadBookmarks();
    const url = list[index];

    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 1200);
      } catch (e) {
        const tmp = document.createElement("input");
        tmp.value = url;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        document.body.removeChild(tmp);
      }
    } else if (action === "delete") {
      removeBookmark(index);
    }
  });

  let turnstileToken = "";
  window.turnstileCallback = function (token) {
    turnstileToken = token;
  };
  window.turnstileExpiredCallback = function () {
    turnstileToken = "";
  };

  generateBtn.addEventListener("click", async function () {
    const rawV = vInput.value.trim();
    const ads = adsInput.value.trim();
    const platform = platformInput.value;

    errorMsg.style.display = "none";
    resultBox.classList.remove("show");

    if (!rawV) {
      errorMsg.textContent = "Link Video is required.";
      errorMsg.style.display = "block";
      return;
    }

    if ((platform === "selfhosted" || platform === "download") && !isValidHttpsUrl(rawV)) {
      const fieldName = platform === "download" ? "Link Download" : "Link Video";
      errorMsg.textContent = "Please enter a valid " + fieldName + " starting with https://";
      errorMsg.style.display = "block";
      return;
    }

    if (!isValidAdsUrl(ads)) {
      errorMsg.textContent = "The ad link must be a valid URL starting with https://";
      errorMsg.style.display = "block";
      return;
    }

    if (!turnstileToken) {
      errorMsg.textContent = "Please complete the captcha verification above first.";
      errorMsg.style.display = "block";
      return;
    }

    const v = rawV;

    generateBtn.disabled = true;
    generateBtn.textContent = "Generating...";

    try {
      const resp = await fetch(API_ORIGIN + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: v, ads: ads, platform: platform, token: turnstileToken }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        throw new Error(data.error || "Failed to generate shortlink.");
      }

      resultInput.value = data.url;
      resultBox.classList.add("show");

      addBookmark(data.url);
    } catch (err) {
      errorMsg.textContent = err.message;
      errorMsg.style.display = "block";
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate shortlink";
      turnstileToken = "";
      if (window.turnstile && window.turnstile.reset) {
        window.turnstile.reset("#turnstileWidget");
      }
    }
  });

  copyBtn.addEventListener("click", async function () {
    resultInput.select();
    try {
      await navigator.clipboard.writeText(resultInput.value);
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
    } catch (e) {
      document.execCommand("copy");
    }
  });

  renderBookmarks();
</script>
</body>
</html>`;
}