import path from 'node:path';

const VIEWPORT_META_TAG =
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />';
const VIEWPORT_META_RE =
  /<meta\b(?=[^>]*\bname\s*=\s*(?:"viewport"|'viewport'|viewport(?=[\s>/])))[^>]*>\s*/gi;

export function isHtmlCandidatePath(pathname) {
  return pathname === '/' || pathname.endsWith('.html') || !path.extname(pathname);
}

export function isSpaShellHtml(html) {
  return typeof html === 'string' && (html.includes('window.__APP_CONFIG__') || html.includes('/main.js'));
}

export function shouldPatchSpaHtml(pathname, html, noMobilePatch = false) {
  if (noMobilePatch) return false;
  if (typeof pathname !== 'string' || !isHtmlCandidatePath(pathname)) return false;
  return isSpaShellHtml(html);
}

export function injectMobileHead(html, assetVersions = {}, inlineAssets = null) {
  const verUrl = (p) => (assetVersions[p] ? `${p}?v=${assetVersions[p]}` : p);
  const useInline = Boolean(inlineAssets && typeof inlineAssets === 'object' && inlineAssets.css && inlineAssets.js);
  const mobilePreload = useInline
    ? ''
    : `\n<link rel="preload" as="style" href="${verUrl('/relay-mobile.css')}" />\n<link rel="preload" as="script" href="${verUrl('/relay-mobile.js')}" />`;
  const preload = `${VIEWPORT_META_TAG}
<link rel="preload" as="style" href="${verUrl('/compiled_tailwind.css')}" />
<link rel="preload" as="style" href="${verUrl('/jetbox.css')}" />${mobilePreload}
<link rel="preload" as="script" href="${verUrl('/main.js')}" />`;

  let out = String(html);
  for (const p of ['/jetbox.css', '/compiled_tailwind.css', '/prism_bundle.js', '/main.js']) {
    if (!assetVersions[p]) continue;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`((?:href|src)=["'])${escaped}(["'])`, 'g'), `$1${verUrl(p)}$2`);
  }

  const openHead = /<head\b[^>]*>/i.exec(out);
  const closeHead = /<\/head>/i.exec(out);
  if (openHead && closeHead && closeHead.index > openHead.index) {
    const headStart = openHead.index + openHead[0].length;
    const headInner = out.slice(headStart, closeHead.index).replace(VIEWPORT_META_RE, '');
    const sep = headInner.startsWith('\n') || headInner.startsWith('\r') ? '' : '\n';
    out = `${out.slice(0, headStart)}\n${preload}${sep}${headInner}${out.slice(closeHead.index)}`;
  } else if (openHead) {
    const headStart = openHead.index + openHead[0].length;
    const tail = out.slice(headStart).replace(VIEWPORT_META_RE, '');
    const sep = tail.startsWith('\n') || tail.startsWith('\r') ? '' : '\n';
    out = `${out.slice(0, headStart)}\n${preload}${sep}${tail}`;
  }

  const mobileCssTag = useInline
    ? `<style data-agy-relay="mobile-css">${inlineAssets.css.replace(/<\/style/gi, '<\\/style')}</style>`
    : `<link rel="stylesheet" href="${verUrl('/relay-mobile.css')}" />`;
  const mobileJsTag = useInline
    ? `<script data-agy-relay="mobile-js">${inlineAssets.js.replace(/<\/script/gi, '<\\/script')}</script>`
    : `<script src="${verUrl('/relay-mobile.js')}"></script>`;

  let placedMobileJsEarly = false;
  if (useInline) {
    const closeHeadIdx = out.search(/<\/head>/i);
    const appCfgMatch = /(<script\b[^>]*>[\s\S]*?window\.__APP_CONFIG__[\s\S]*?<\/script>)/i.exec(out);
    if (appCfgMatch && (closeHeadIdx === -1 || appCfgMatch.index < closeHeadIdx)) {
      const splitAt = appCfgMatch.index + appCfgMatch[0].length;
      out = `${out.slice(0, splitAt)}\n${mobileJsTag}${out.slice(splitAt)}`;
      placedMobileJsEarly = true;
    }
  }

  const snippet = `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
<link rel="icon" type="image/png" sizes="192x192" href="/relay-icon-192.png" />
<link rel="apple-touch-icon" sizes="192x192" href="/relay-icon-192.png" />
<meta name="theme-color" content="#0b0b0f" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
${mobileCssTag}${placedMobileJsEarly ? '' : `\n${mobileJsTag}`}`;

  const idxMatch = /<\/head>/i.exec(out);
  if (!idxMatch) return out;
  return `${out.slice(0, idxMatch.index)}${snippet}\n${out.slice(idxMatch.index)}`;
}

const APP_CONFIG_EMPTY_CSRF_RE =
  /(window\.__APP_CONFIG__\s*=\s*\{[^<]*?"csrfToken"\s*:\s*)""/;

export function injectCsrfToken(html, csrfToken) {
  const out = String(html);
  if (!csrfToken || typeof csrfToken !== 'string') return out;
  return out.replace(APP_CONFIG_EMPTY_CSRF_RE, (_, prefix) => `${prefix}${JSON.stringify(csrfToken)}`);
}
